import { execute, type AmpOptions } from '@ampcode/sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type AmpMcpServerConfig =
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      disabled?: boolean;
    }
  | {
      url: string;
      headers?: Record<string, string>;
      disabled?: boolean;
      transport?: string;
    };

export type AmpMcpConfig = Record<string, AmpMcpServerConfig>;

export interface AmpExecutionOptions {
  cwd: string;
  env?: Record<string, string>;
  mode?: 'low' | 'medium' | 'high' | 'ultra';
  executor?: 'local' | 'orb';
  project?: string;
  dangerouslyAllowAll?: boolean;
  mcpConfig?: AmpMcpConfig;
  continue?: boolean | string;
}

export interface AmpStreamMessage {
  type: string;
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  error?: string;
  parent_tool_use_id?: string | null;
  message?: {
    content: unknown;
    stop_reason?: string | null;
  };
}

export interface AmpExecutionRequest {
  sessionId: string;
  prompt: string;
  options: AmpExecutionOptions;
  signal: AbortSignal;
  steer: boolean;
}

export interface AmpTransport {
  readonly name: 'cli' | 'sdk';
  readonly supportsSteering?: boolean;
  execute(request: AmpExecutionRequest): AsyncIterable<AmpStreamMessage>;
  closeSession?(sessionId: string): void;
  closeAll?(): void;
}

export interface AmpThreadLifecycleOptions {
  command?: string;
  commandArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

const AMP_THREAD_ID_PATTERN = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAmpThreadId(value: unknown): value is string {
  return typeof value === 'string' && AMP_THREAD_ID_PATTERN.test(value);
}

export function buildAmpArchiveArgs(threadId: string, archived: boolean): string[] {
  if (!isAmpThreadId(threadId)) {
    throw new Error(`Invalid Amp thread ID: ${threadId}`);
  }
  return archived
    ? ['threads', 'archive', threadId]
    : ['threads', 'archive', '--unarchive', threadId];
}

export async function setAmpThreadArchived(
  threadId: string,
  archived: boolean,
  options: AmpThreadLifecycleOptions = {},
): Promise<void> {
  const command = options.command ?? process.env.AMP_CLI_PATH ?? 'amp';
  const child = spawn(command, [
    ...(options.commandArgs ?? []),
    ...buildAmpArchiveArgs(threadId, archived),
  ], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  const { code, processSignal } = await new Promise<{
    code: number | null;
    processSignal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, processSignal) => resolve({ code, processSignal }));
  });

  if (code === null) {
    throw new Error(`Amp CLI process was killed by signal ${processSignal ?? 'unknown'}`);
  }
  if (code !== 0) {
    const details = Buffer.concat(stderr).toString().trim();
    throw new Error(`Amp CLI process exited with code ${code}${details ? `: ${details}` : ''}`);
  }
}

const sdkTransport: AmpTransport = {
  name: 'sdk',
  execute(request) {
    return execute({
      prompt: request.prompt,
      options: buildAmpSdkOptions(request.options),
      signal: request.signal,
    });
  },
};

export function buildAmpSdkOptions(options: AmpExecutionOptions): AmpOptions {
  return {
    cwd: options.cwd,
    env: options.env,
    mode: options.mode,
    executor: options.executor,
    project: options.project,
    noArchiveAfterExecute: true,
    dangerouslyAllowAll: options.dangerouslyAllowAll,
    mcpConfig: options.mcpConfig,
    continue: options.continue,
  };
}

export function buildAmpCliArgs(options: AmpExecutionOptions): string[] {
  const args: string[] = [];

  if (typeof options.continue === 'string') {
    args.push('threads', 'continue', options.continue);
  } else if (options.continue) {
    args.push('threads', 'continue', '--last');
  }

  args.push('--execute', '--stream-json', '--stream-json-input');
  args.push('--no-archive-after-execute');
  if (options.mode) args.push('--mode', options.mode);
  if (options.dangerouslyAllowAll) args.push('--dangerously-allow-all');
  if (options.mcpConfig) args.push('--mcp-config', JSON.stringify(options.mcpConfig));

  return args;
}

function formatPromptInput(prompt: string, steer: boolean): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
    steer,
  })}\n`;
}

interface QueuedMessage {
  message: AmpStreamMessage;
  promptSequence?: number;
}

interface QueueWaiter {
  resolve(message: QueuedMessage): void;
  reject(error: Error): void;
}

class MessageQueue {
  private messages: QueuedMessage[] = [];
  private waiters: QueueWaiter[] = [];
  private error: Error | null = null;

  push(message: QueuedMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(message);
    } else {
      this.messages.push(message);
    }
  }

  fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  shift(signal: AbortSignal): Promise<QueuedMessage> {
    if (signal.aborted) return Promise.reject(abortedError());
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    if (this.error) return Promise.reject(this.error);

    return new Promise((resolve, reject) => {
      const waiter: QueueWaiter = {
        resolve: (next) => {
          signal.removeEventListener('abort', onAbort);
          resolve(next);
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(abortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }
}

interface CliSession {
  child: ChildProcessWithoutNullStreams;
  queue: MessageQueue;
  stderr: Buffer[];
  nextPromptSequence: number;
  pendingPromptEchoes: { prompt: string; sequence: number }[];
}

function abortedError(): Error {
  const error = new Error('Amp CLI prompt was cancelled');
  error.name = 'AbortError';
  return error;
}

function processExitError(
  code: number | null,
  processSignal: NodeJS.Signals | null,
  stderr: Buffer[],
): Error {
  if (code === null) return new Error(`Amp CLI process was killed by signal ${processSignal ?? 'unknown'}`);
  const details = Buffer.concat(stderr).toString().trim();
  return new Error(`Amp CLI process exited with code ${code}${details ? `: ${details}` : ''}`);
}

function isPromptEcho(message: AmpStreamMessage, prompt: string): boolean {
  if (message.type !== 'user' || !Array.isArray(message.message?.content)) return false;
  const text = message.message.content
    .filter((part): part is { type: 'text'; text: string } => (
      typeof part === 'object' && part !== null &&
      'type' in part && part.type === 'text' &&
      'text' in part && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('');
  return text === prompt;
}

function isPromptComplete(message: AmpStreamMessage): boolean {
  const stopReason = message.message?.stop_reason;
  return message.type === 'result' || (
    message.type === 'assistant' &&
    message.parent_tool_use_id == null &&
    typeof stopReason === 'string' &&
    stopReason !== 'tool_use' &&
    stopReason !== 'pause_turn'
  );
}

export function createCliTransport(
  command = process.env.AMP_CLI_PATH ?? 'amp',
  commandArgs: string[] = [],
  preserveCancelledProcess = process.env.AMP_ACP_CANCEL_MODE === 'steer',
): AmpTransport {
  const sessions = new Map<string, CliSession>();

  const terminateSession = (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return Promise.resolve();
    sessions.delete(sessionId);
    if (session.child.exitCode !== null || session.child.signalCode !== null) return Promise.resolve();
    const closed = new Promise<void>((resolve) => session.child.once('close', () => resolve()));
    session.child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    return closed;
  };

  const closeSession = (sessionId: string): void => {
    void terminateSession(sessionId);
  };

  const startSession = (sessionId: string, options: AmpExecutionOptions): CliSession => {
    const child = spawn(command, [...commandArgs, ...buildAmpCliArgs(options)], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session: CliSession = {
      child,
      queue: new MessageQueue(),
      stderr: [],
      nextPromptSequence: 0,
      pendingPromptEchoes: [],
    };
    sessions.set(sessionId, session);
    const failSession = (error: Error): void => {
      session.queue.fail(error);
      if (sessions.get(sessionId) === session) closeSession(sessionId);
    };
    child.stderr.on('data', (chunk: Buffer) => session.stderr.push(chunk));
    child.stdin.on('error', failSession);

    void (async () => {
      try {
        const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as AmpStreamMessage;
            const pendingIndex = session.pendingPromptEchoes.findIndex(
              (pending) => isPromptEcho(message, pending.prompt),
            );
            const promptSequence = pendingIndex === -1
              ? undefined
              : session.pendingPromptEchoes.splice(0, pendingIndex + 1).at(-1)?.sequence;
            session.queue.push({ message, promptSequence });
          } catch {
            throw new Error(`Failed to parse JSON response, raw line: ${line}`);
          }
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failSession(failure);
      }
    })();

    child.once('error', failSession);
    child.once('close', (code, processSignal) => {
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      session.queue.fail(processExitError(code, processSignal, session.stderr));
    });
    return session;
  };

  const transport: AmpTransport = {
    name: 'cli',
    supportsSteering: preserveCancelledProcess,
    async *execute({ sessionId, prompt, options, signal, steer }) {
      signal.throwIfAborted();

      let session = sessions.get(sessionId);
      session ??= startSession(sessionId, options);
      const promptSequence = ++session.nextPromptSequence;

      try {
        session.pendingPromptEchoes.push({ prompt, sequence: promptSequence });
        try {
          await new Promise<void>((resolve, reject) => {
            session.child.stdin.write(formatPromptInput(prompt, steer), (error) => error ? reject(error) : resolve());
          });
        } catch (error) {
          const index = session.pendingPromptEchoes.findIndex((pending) => pending.sequence === promptSequence);
          if (index !== -1) session.pendingPromptEchoes.splice(index, 1);
          throw error;
        }
        let promptEchoed = false;
        for (;;) {
          const queued = await session.queue.shift(signal);
          const { message } = queued;
          if (queued.promptSequence === promptSequence) {
            promptEchoed = true;
          } else if (!promptEchoed) {
            if (message.type === 'system') yield message;
            continue;
          }
          yield message;
          if (promptEchoed && isPromptComplete(message)) return;
        }
      } catch (error) {
        if (signal.aborted) {
          if (!preserveCancelledProcess) await terminateSession(sessionId);
          throw abortedError();
        }
        throw error;
      }
    },
    closeSession,
    closeAll() {
      for (const sessionId of [...sessions.keys()]) closeSession(sessionId);
    },
  };

  return transport;
}

export function createAmpTransport(name = process.env.AMP_ACP_TRANSPORT ?? 'cli'): AmpTransport {
  switch (name) {
    case 'sdk':
      return sdkTransport;
    case 'cli':
      return createCliTransport();
    default:
      throw new Error(`Unsupported AMP_ACP_TRANSPORT: ${name}`);
  }
}
