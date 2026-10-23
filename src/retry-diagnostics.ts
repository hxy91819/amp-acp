import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { defaultAmpAcpStateDir } from './state-directory.js';

export type FailureKind = 'overloaded' | 'connection' | 'authentication' | 'subscription' | 'rate_limit' | 'process_exit' | 'protocol' | 'unknown';
export type RetryStopReason = 'retry' | 'max_retries' | 'window_expired' | 'thread_unknown' | 'input_unacknowledged' | 'steer_unacknowledged' | 'cancelled' | 'connection_closed' | 'consumer_closed';
export interface RetryDiagnostic {
  event: 'execution_started' | 'failure' | 'retry_scheduled' | 'retry_started' | 'recovery_resumed' | 'completed' | 'recovered' | 'stopped' | 'cancelled';
  executionId: string;
  sessionId?: string;
  ampThreadId?: string;
  attempt: number;
  elapsedMs: number;
  recoveryElapsedMs?: number;
  reason?: RetryStopReason;
  failureKind?: FailureKind;
  failureFingerprint?: string;
  promptAcknowledged?: boolean;
  pendingInputs?: number;
  maxRetries?: number;
  maxWindowMs?: number;
  delayMs?: number;
  remainingMs?: number;
  nextRetryAt?: string;
}
export type RetryLogger = (entry: RetryDiagnostic) => void;

/** Best-effort, bounded diagnostics; caller supplies categories, never error bodies. */
export function createRetryLogger(directory = path.join(defaultAmpAcpStateDir(), 'logs'), maxBytes = 1024 * 1024): RetryLogger {
  const threadId = /^thr_[a-z0-9]+$/i.test(process.env.BB_THREAD_ID ?? '') ? process.env.BB_THREAD_ID : undefined;
  const filename = path.join(directory, `retry-${threadId ?? process.pid}.jsonl`);
  let warned = false;
  return (entry) => {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, bbThreadId: threadId, ...entry });
    console.error(`[amp-retry] ${line}`);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (existsSync(filename) && statSync(filename).size + Buffer.byteLength(line) + 1 > maxBytes) {
        renameSync(filename, `${filename}.1`);
      }
      appendFileSync(filename, `${line}\n`, { mode: 0o600 });
    } catch {
      if (!warned) {
        warned = true;
        console.error('[amp-retry] Unable to persist retry diagnostics; stderr logging remains available.');
      }
    }
  };
}
