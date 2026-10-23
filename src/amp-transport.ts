import { execute, type AmpOptions } from '@ampcode/sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { formatPromptInput } from './cli-prompt.js';
import { setTimeout as delay } from 'node:timers/promises';

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

/** A built-in or plugin-defined Amp mode key. Amp resolves it to an agent and model. */
export type AmpMode = string & {};

export interface AmpExecutionOptions {
  cwd: string;
  env?: Record<string, string>;
  mode?: AmpMode;
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
  retry?: { attempt: number; maxRetries: number; delayMs: number };
  message?: {
    content: unknown;
    stop_reason?: string | null;
  };
}

export interface AmpExecutionRequest {
  sessionId: string;
  prompt: string | AmpPromptContent[];
  options: AmpExecutionOptions;
  signal: AbortSignal;
  steer: boolean;
}

/** Content accepted by Amp CLI --stream-json-input. */
export type AmpPromptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface AmpTransport {
  readonly name: 'cli' | 'sdk';
  /** Preserves execution across cancellation for legacy cancel-then-prompt steering. */
  readonly supportsSteering?: boolean;
  execute(request: AmpExecutionRequest): AsyncIterable<AmpStreamMessage>;
  /** Inject into the original iterator; false requests cancel-then-prompt fallback. */
  steer?(request: AmpExecutionRequest): Promise<boolean>;
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
    if (typeof request.prompt !== 'string') {
      throw new Error('Image prompts require the local CLI transport; the Amp SDK only accepts text');
    }
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

function getPromptText(prompt: AmpExecutionRequest['prompt']): string {
  return typeof prompt === 'string' ? prompt : prompt
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
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
  lastFailure?: string;
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
  if (message.type !== 'user' || message.parent_tool_use_id != null || !Array.isArray(message.message?.content)) return false;
  if (message.message.content.some((part) => typeof part === 'object' && part !== null &&
    'type' in part && part.type === 'tool_result')) return false;
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

export interface AmpRetryPolicy {
  maxRetries: number;
  delayMs: number;
  maxDelayMs?: number;
  maxDurationMs?: number;
}

const MAX_RETRY_WINDOW_MS = 60 * 60 * 1000;

function defaultRetryPolicy(): AmpRetryPolicy {
  const value = process.env.AMP_ACP_MAX_RETRIES;
  const maxRetries = value === undefined ? 50 : Number(value);
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('AMP_ACP_MAX_RETRIES must be a non-negative integer');
  }
  const windowSeconds = Number(process.env.AMP_ACP_RETRY_WINDOW_SECONDS ?? 3600);
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || windowSeconds > 3600) {
    throw new Error('AMP_ACP_RETRY_WINDOW_SECONDS must be greater than 0 and at most 3600');
  }
  return { maxRetries, delayMs: 30000, maxDelayMs: 300000, maxDurationMs: windowSeconds * 1000 };
}

function isTransientFailure(error: string): boolean {
  if (/unauthorized|forbidden|auth|login|invalid.?api.?key|insufficient|quota|credits|balance|subscription.*(?:expired|inactive|cancelled|canceled|not active|invalid|missing|required)|(?:expired|inactive|invalid|missing) (?:model )?subscription/i.test(error)) return false;
  return /WebSocket closed:\s*(1006|1011|1012|1013)\b|\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|\b(?:HTTP|status(?: code)?)[ :]+(?:408|429|500|502|503|504)\b/i.test(error);
}

const RECOVERY_PROMPT = 'Continue the interrupted turn from the existing thread context. Check completed tool results first and continue only unfinished work; do not repeat completed actions.';

export function createCliTransport(
  command = process.env.AMP_CLI_PATH ?? 'amp',
  commandArgs: string[] = [],
  preserveCancelledProcess = process.env.AMP_ACP_CANCEL_MODE === 'steer',
  retryPolicy: AmpRetryPolicy = defaultRetryPolicy(),
): AmpTransport {
  const executions = new Map<string, AbortController>();
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
    executions.get(sessionId)?.abort();
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
      if (sessions.get(sessionId) === session) void terminateSession(sessionId);
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
            if (message.type === 'result' && message.is_error) {
              session.lastFailure = message.error ?? 'Amp CLI execution failed';
            }
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
      session.queue.fail(session.lastFailure
        ? new Error(session.lastFailure)
        : processExitError(code, processSignal, session.stderr));
    });
    return session;
  };

  const writePrompt = async (
    session: CliSession,
    prompt: AmpExecutionRequest['prompt'],
    text: string,
    steer: boolean,
  ): Promise<number> => {
    const sequence = ++session.nextPromptSequence;
    session.pendingPromptEchoes.push({ prompt: text, sequence });
    try {
      await new Promise<void>((resolve, reject) => {
        session.child.stdin.write(formatPromptInput(prompt, steer), (error) => error ? reject(error) : resolve());
      });
      return sequence;
    } catch (error) {
      const index = session.pendingPromptEchoes.findIndex((pending) => pending.sequence === sequence);
      if (index !== -1) session.pendingPromptEchoes.splice(index, 1);
      throw error;
    }
  };

  const transport: AmpTransport = {
    name: 'cli',
    supportsSteering: preserveCancelledProcess,
    async steer({ sessionId, prompt, signal }) {
      signal.throwIfAborted();
      const session = sessions.get(sessionId);
      if (!session) return false;
      const promptText = getPromptText(prompt);
      // Amp echoes neither request IDs nor image content. An identical pending
      // echo cannot distinguish an old turn from one superseded by this steer.
      if (session.pendingPromptEchoes.some((pending) => pending.prompt === promptText)) return false;
      await writePrompt(session, prompt, promptText, true);
      return true;
    },
    async *execute({ sessionId, prompt, options, signal: requestSignal, steer }) {
      requestSignal.throwIfAborted();
      const lifecycle = new AbortController();
      executions.set(sessionId, lifecycle);
      const signal = AbortSignal.any([requestSignal, lifecycle.signal]);
      let recoveryThreadId = typeof options.continue === 'string' && isAmpThreadId(options.continue)
        ? options.continue : undefined;
      let currentPrompt = prompt;
      let currentOptions = options;
      let inputSteer = steer;
      let recoveryStartedAt: number | undefined;
      const maxDurationMs = Math.min(retryPolicy.maxDurationMs ?? MAX_RETRY_WINDOW_MS, MAX_RETRY_WINDOW_MS);

      try {
        for (let attempt = 0; ; attempt++) {
          signal.throwIfAborted();
          const promptText = getPromptText(currentPrompt);
          let session = sessions.get(sessionId);
          if (session?.pendingPromptEchoes.some((pending) => pending.prompt === promptText)) {
            await terminateSession(sessionId);
            signal.throwIfAborted();
            session = undefined;
          }
          // A replacement process starts with an ordinary prompt, never a steer.
          if (!session) inputSteer = false;
          session ??= startSession(sessionId, currentOptions);
          let retryError: string | undefined;
          try {
            const promptSequence = await writePrompt(session, currentPrompt, promptText, inputSteer);
            let promptEchoed = false;
            let lastEchoedSequence = 0;
            for (;;) {
              const { message, promptSequence: echoedSequence } = await session.queue.shift(signal);
              if (message.session_id && isAmpThreadId(message.session_id)) recoveryThreadId = message.session_id;
              if (echoedSequence !== undefined && echoedSequence >= promptSequence) {
                promptEchoed = true;
                lastEchoedSequence = echoedSequence;
              }
              if (message.type === 'result' && message.is_error) {
                const error = message.error ?? 'Amp CLI execution failed';
                const transient = isTransientFailure(error);
                if (transient) recoveryStartedAt ??= performance.now();
                const withinWindow = recoveryStartedAt !== undefined && performance.now() - recoveryStartedAt < maxDurationMs;
                const canRetry = attempt < retryPolicy.maxRetries && recoveryThreadId && promptEchoed
                  && lastEchoedSequence === session.nextPromptSequence && transient && withinWindow;
                if (sessions.get(sessionId) === session) await terminateSession(sessionId);
                signal.throwIfAborted();
                if (!canRetry) {
                  yield message;
                  throw new Error(error);
                }
                retryError = error;
                break;
              }
              if (!promptEchoed) {
                if (message.type === 'system') yield message;
                continue;
              }
              yield message;
              if (lastEchoedSequence === session.nextPromptSequence && isPromptComplete(message)) return;
            }
          } catch (error) {
            if (signal.aborted) {
              if ((!preserveCancelledProcess || lifecycle.signal.aborted) && sessions.get(sessionId) === session) {
                await terminateSession(sessionId);
              }
              throw abortedError();
            }
            throw error;
          }
          if (retryError) {
            const remainingMs = maxDurationMs - (performance.now() - recoveryStartedAt!);
            if (remainingMs <= 0) throw new Error(retryError);
            const delayMs = Math.min(retryPolicy.delayMs * 2 ** attempt, retryPolicy.maxDelayMs ?? 300000, remainingMs);
            console.error(`[amp] transient model failure; retry ${attempt + 1}/${retryPolicy.maxRetries} in ${delayMs}ms`);
            yield { type: 'system', subtype: 'retry', retry: { attempt: attempt + 1, maxRetries: retryPolicy.maxRetries, delayMs } };
            await delay(delayMs, undefined, { signal });
            if (delayMs === remainingMs || performance.now() - recoveryStartedAt! >= maxDurationMs) {
              throw new Error(`${retryError} (automatic retry window exhausted)`);
            }
            currentPrompt = RECOVERY_PROMPT;
            currentOptions = { ...options, continue: recoveryThreadId };
            inputSteer = false;
          }
        }
      } finally {
        if (executions.get(sessionId) === lifecycle) executions.delete(sessionId);
      }
    },
    closeSession,
    closeAll() {
      for (const sessionId of new Set([...executions.keys(), ...sessions.keys()])) closeSession(sessionId);
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
