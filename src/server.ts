import {
  RequestError,
  type AgentSideConnection,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ClientCapabilities,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import {
  createAmpTransport,
  type AmpExecutionOptions,
  type AmpTransport,
} from './amp-transport.js';
import { createAmpModeCatalog, type AmpModeCatalog, type AmpModeOption } from './amp-modes.js';
import { convertAcpMcpServersToAmpConfig, type AmpMcpConfig } from './mcp-config.js';
import { toAcpNotifications } from './to-acp.js';
import path from 'node:path';
import packageJson from '../package.json';

const PACKAGE_VERSION: string = packageJson.version;
const CONFIG_PERMISSION = 'permission';
const CONFIG_AMP_MODE = 'amp-mode';
const PERMISSION_MODES = ['default', 'bypass'] as const;

type PermissionMode = typeof PERMISSION_MODES[number];

function isPermissionMode(mode: string): mode is PermissionMode {
  return PERMISSION_MODES.some((permissionMode) => permissionMode === mode);
}

function buildSessionConfigOptions(s: Pick<SessionState, 'mode' | 'ampModeKey' | 'ampModes' | 'modeDiscoveryDiagnostic'>): SessionConfigOption[] {
  return [
    {
      type: 'select',
      id: CONFIG_PERMISSION,
      name: 'Permissions',
      description: 'Controls whether Amp uses configured permissions or force-allows tool calls.',
      category: 'mode',
      currentValue: s.mode,
      options: [
        {
          value: 'default',
          name: 'Default',
          description:
            "Use Amp's configured behavior. As of Amp Neo, tools run without prompts unless you've opted into permissions.",
        },
        {
          value: 'bypass',
          name: 'Bypass',
          description: 'Force-allow every tool call, overriding any configured permissions plugin.',
        },
      ],
    },
    {
      type: 'select',
      id: CONFIG_AMP_MODE,
      name: 'Amp Mode',
      description: s.modeDiscoveryDiagnostic
        ? `Select the Amp agent mode. ${s.modeDiscoveryDiagnostic}`
        : 'Select the Amp agent mode. Amp owns model routing for the selected mode.',
      category: 'model',
      currentValue: s.ampModeKey,
      options: s.ampModes.map((mode) => ({
        value: mode.key,
        name: mode.label,
        description: mode.description,
      })),
    },
  ];
}

interface SessionState {
  threadId: string | null;
  controller: AbortController | null;
  cancelled: boolean;
  steerNextPrompt: boolean;
  active: boolean;
  processStarted: boolean;
  mode: PermissionMode;
  /** Stable Amp mode key. This is distinct from the mode's display label and model ID. */
  ampModeKey: string;
  ampModes: readonly AmpModeOption[];
  modeDiscoveryDiagnostic?: string;
  modeLocked: boolean;
  mcpConfig: AmpMcpConfig;
  cwd: string;
}

interface InitializeResponseWithAgentInfo extends InitializeResponse {
  agentInfo: {
    name: string;
    title: string;
    version: string;
  };
}

interface AmpAcpAgentOptions {
  /** Lists selectable modes for the session cwd; defaults to the Amp CLI-backed catalog. */
  modeCatalog?: AmpModeCatalog;
}

export class AmpAcpAgent implements Agent {
  private client: AgentSideConnection;
  private transport: AmpTransport;
  sessions = new Map<string, SessionState>();
  private clientCapabilities?: ClientCapabilities;
  private modeCatalog: AmpModeCatalog;

  constructor(
    client: AgentSideConnection,
    transport = createAmpTransport(),
    options: AmpAcpAgentOptions = {},
  ) {
    this.client = client;
    this.transport = transport;
    this.modeCatalog = options.modeCatalog ?? createAmpModeCatalog();
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponseWithAgentInfo> {
    this.clientCapabilities = request.clientCapabilities;
    console.info(`[acp] amp-acp v${PACKAGE_VERSION} initialized`);
    return {
      protocolVersion: 1,
      agentInfo: {
        name: 'amp-acp',
        title: 'Amp ACP Agent',
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [
        {
          id: 'setup',
          name: 'Amp API Key Setup',
          description: 'Run interactive setup to configure your Amp API key',
          _meta: {
            'terminal-auth': {
              command: getTerminalAuthCommand(),
              args: ['--setup'],
              label: 'Amp API Key Setup',
            },
          },
        },
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);
    const cwd = params.cwd || process.cwd();
    const modeCatalogResult = await this.modeCatalog(cwd);

    const session: SessionState = {
      threadId: null,
      controller: null,
      cancelled: false,
      steerNextPrompt: false,
      active: false,
      processStarted: false,
      mode: 'default',
      ampModeKey: 'medium',
      ampModes: modeCatalogResult.modes,
      modeDiscoveryDiagnostic: modeCatalogResult.diagnostic,
      modeLocked: false,
      mcpConfig,
      cwd,
    };
    this.sessions.set(sessionId, session);

    const result: NewSessionResponse = {
      sessionId,
      configOptions: buildSessionConfigOptions(session),
    };

    setImmediate(async () => {
      try {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              {
                name: 'init',
                description: 'Generate an AGENTS.md file for the project',
              },
            ],
          },
        });
      } catch (e) {
        console.error('[acp] failed to send available_commands_update', e);
      }
    });

    return result;
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    if (process.env.AMP_API_KEY) {
      return {};
    }
    throw RequestError.authRequired();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    s.cancelled = false;
    s.active = true;
    s.modeLocked = true;
    const steer = s.steerNextPrompt;
    s.steerNextPrompt = false;

    let textInput = '';
    for (const chunk of params.prompt) {
      switch (chunk.type) {
        case 'text':
          if (chunk.text.trim() === '/init') {
            textInput += `Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Architecture and codebase structure information, including important subprojects, internal APIs, databases, etc.
3. Code style guidelines, including imports, conventions, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding tools (such as yourself) that operate in this repository. Make it about 20 lines long.

If there are Cursor rules (in .cursor/rules/ or .cursorrules), Claude rules (CLAUDE.md), Windsurf rules (.windsurfrules), Cline rules (.clinerules), Goose rules (.goosehints), or Copilot rules (in .github/copilot-instructions.md), make sure to include them. Also, first check if there is an existing AGENTS.md or AGENT.md file, and if so, update it instead of overwriting it.`;
          } else {
            textInput += chunk.text;
          }
          break;
        case 'resource_link':
          textInput += `\n${chunk.uri}\n`;
          break;
        case 'resource':
          if ('text' in chunk.resource) {
            textInput += `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>\n`;
          }
          break;
        case 'image':
          break;
        default:
          break;
      }
    }

    const options: AmpExecutionOptions = {
      cwd: s.cwd,
      env: { TERM: 'dumb' },
      mode: s.ampModeKey,
    };

    if (s.mode === 'bypass') {
      options.dangerouslyAllowAll = true;
    }

    if (Object.keys(s.mcpConfig).length > 0) {
      options.mcpConfig = s.mcpConfig;
    }

    if (s.threadId) {
      options.continue = s.threadId;
    } else if (process.env.AMP_ACP_CONTINUE_LATEST) {
      options.continue = true;
      console.error('[acp] AMP_ACP_CONTINUE_LATEST set; continuing latest thread on this installation');
    }

    const controller = new AbortController();
    s.controller = controller;
    if (this.transport.name === 'cli') s.processStarted = true;

    try {
      for await (const message of this.transport.execute({
        sessionId: params.sessionId,
        prompt: textInput,
        options,
        signal: controller.signal,
        steer,
      })) {
        if (!s.threadId && message.session_id) {
          s.threadId = message.session_id;
          console.error(`[amp] thread ${s.threadId}`);
        }

        if (message.type === 'assistant' || message.type === 'user') {
          for (const n of toAcpNotifications(message, params.sessionId)) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        }

        if (message.type === 'result' && message.is_error) {
          if (typeof message.error === 'string' && isAuthError(message.error)) {
            console.error('[amp] Auth error in result, requesting authentication:', message.error);
            throw RequestError.authRequired();
          }
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Error: ${message.error}` } },
          });
        }
      }

      return { stopReason: s.cancelled ? 'cancelled' : 'end_turn' };
    } catch (err) {
      if (s.cancelled || (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted')))) {
        return { stopReason: 'cancelled' };
      }
      if (err instanceof Error && isAuthError(err.message)) {
        console.error('[amp] Auth error, requesting authentication:', err.message);
        throw RequestError.authRequired();
      }
      console.error('[amp] Execution error:', err);
      throw err;
    } finally {
      s.active = false;
      s.cancelled = false;
      s.controller = null;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return;
    if (s.active && s.controller) {
      s.cancelled = true;
      s.steerNextPrompt = s.threadId !== null;
      s.controller.abort();
    }
  }

  close(): void {
    this.transport.closeAll?.();
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (this.transport.name === 'cli' && s.processStarted) {
      throw new Error('Session configuration cannot change after the Amp process has started');
    }
    if (typeof params.value !== 'string') {
      throw RequestError.invalidParams(
        { configId: params.configId, value: params.value },
        `Unsupported value for ${params.configId}`,
      );
    }

    switch (params.configId) {
      case CONFIG_PERMISSION:
        if (!isPermissionMode(params.value)) {
          throw RequestError.invalidParams(
            { configId: params.configId, value: params.value },
            `Unsupported permission mode: ${params.value}`,
          );
        }
        s.mode = params.value;
        break;
      case CONFIG_AMP_MODE:
        if (s.modeLocked) {
          throw RequestError.invalidParams(
            { configId: params.configId, value: params.value },
            'Amp mode is fixed after the first prompt. Start a new session to select a different mode.',
          );
        }
        const modeValue = params.value.trim().toLowerCase();
        const matches = s.ampModes.filter((mode) =>
          mode.key.toLowerCase() === modeValue || mode.label.toLowerCase() === modeValue,
        );
        if (matches.length !== 1) {
          throw RequestError.invalidParams(
            { configId: params.configId, value: params.value },
            `Unsupported Amp mode: ${params.value}. Select a mode advertised for this session or start a new session after enabling its plugin.`,
          );
        }
        const selectedMode = matches[0];
        if (!selectedMode) {
          throw RequestError.invalidParams(
            { configId: params.configId, value: params.value },
            `Unsupported Amp mode: ${params.value}.`,
          );
        }
        // Preserve the stable key: labels are for display, and model IDs belong
        // to the plugin definition rather than to this ACP adapter.
        s.ampModeKey = selectedMode.key;
        break;
      default:
        throw RequestError.invalidParams(
          { configId: params.configId, value: params.value },
          `Unsupported config option: ${params.configId}`,
        );
    }

    const configOptions = buildSessionConfigOptions(s);
    try {
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions,
        },
      });
    } catch (e) {
      console.error('[acp] failed to send config_option_update', e);
    }

    return { configOptions };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (!isPermissionMode(params.modeId)) {
      throw new Error(`Unsupported mode: ${params.modeId}`);
    }
    s.mode = params.modeId;
    return {};
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> { return this.client.readTextFile(params); }
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> { return this.client.writeTextFile(params); }
}

export function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('invalid or missing api key') ||
    lower.includes("run 'amp login'") ||
    lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('no api key found') ||
    (lower.includes('api key') && lower.includes('login flow')) ||
    (lower.includes('api key') && (lower.includes('missing') || lower.includes('invalid')));
}

export function getTerminalAuthCommand(
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string {
  const resolvedArgv1 = argv1 ? path.resolve(argv1) : '';
  if (!resolvedArgv1 || resolvedArgv1.startsWith('/$bunfs/')) {
    return execPath;
  }
  return resolvedArgv1;
}
