import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentSideConnection, ClientSideConnection, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk';
import { AmpAcpAgent } from './server.js';
import { BUILTIN_AMP_MODES } from './amp-modes.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';
import type { RetryDiagnostic } from './retry-diagnostics.js';
import { createCliTransport, type AmpStreamMessage, type AmpTransport, type AmpRetryPolicy } from './amp-transport.js';

const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';
const transient = 'OpenAI WebSocket closed: 1006';
const overload = 'OpenAI stream error (server_is_overloaded): Our servers are currently overloaded. Please try again later. If this persists, deactivate your ChatGPT subscription: https://ampcode.com/settings/model-routing';
let directory: string;
let fixture: string;
let sequence = 0;
const transports: AmpTransport[] = [];

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'amp-retry-test-'));
  fixture = path.join(directory, 'amp.mjs');
  await writeFile(fixture, `
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
const log = process.argv[2];
const scenario = process.argv[3];
const emit = (message) => console.log(JSON.stringify(message));
createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  const prompt = input.message.content.map((part) => part.text).join('');
  appendFileSync(log, JSON.stringify({ prompt, args: process.argv.slice(4), steer: input.steer }) + '\\n');
  const attempt = readFileSync(log, 'utf8').trim().split('\\n').length;
  emit({ type: 'system', subtype: 'init', session_id: '${threadId}' });
  const fail = () => {
    emit({ type: 'result', is_error: true, error: scenario === 'auth' ? 'Unauthorized: login required' : scenario === 'parameter' ? 'Invalid model parameter' : scenario === 'subscription' ? 'HTTP 429: model subscription expired' : scenario === 'empty-error' ? '' : scenario === 'overload' ? '${overload}' : scenario === 'unknown' ? 'Unexpected upstream response: PRIVATE_ERROR_SENTINEL' : '${transient}' });
    process.exit(0);
  };
  if (scenario === 'pre-echo') { fail(); return; }
  if (scenario === 'exit-zero') { process.exit(0); }
  if (scenario === 'pending-steer' && input.steer) { fail(); return; }
  emit({ type: 'user', message: { content: input.message.content } });
  if (scenario === 'exit-after-echo' && attempt === 1) { process.exit(0); }
  if ((scenario === 'pending-steer' || scenario === 'accepted-steer') && attempt === 1) {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'waiting for steer' }], stop_reason: null } });
    return;
  }
  if (attempt === 1) {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'once', name: 'Bash', input: { cmd: 'one side effect' } }], stop_reason: 'tool_use' } });
  }
  if (scenario === 'accepted-steer' && input.steer) { fail(); return; }
  if (scenario === 'always' || scenario === 'auth' || scenario === 'parameter' || scenario === 'subscription' || attempt === 1) { fail(); return; }
  const complete = () => emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn' } });
  if (scenario === 'empty-progress-recovery') {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: '' }], stop_reason: null } });
    setTimeout(complete, 500); return;
  }
  if (scenario === 'delayed-recovery') { setTimeout(complete, 500); return; }
  if (scenario === 'healthy-recovery') {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'normal task progress' }], stop_reason: null } });
    setTimeout(complete, 500); return;
  }
  complete();
});
`);
});
afterEach(() => { for (const transport of transports.splice(0)) transport.closeAll?.(); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function setup(scenario = 'once', maxRetries = 3, delayMs = 1, policy: Partial<AmpRetryPolicy> = {}) {
  const log = path.join(directory, `input-${++sequence}.jsonl`);
  const diagnostics: RetryDiagnostic[] = [];
  const transport = createCliTransport(process.execPath, [fixture, log, scenario], true, { maxRetries, delayMs, ...policy }, (entry) => diagnostics.push(entry));
  transports.push(transport);
  const controller = new AbortController();
  const request = { sessionId: `session-${sequence}`, prompt: 'original instruction', options: { cwd: directory }, signal: controller.signal, steer: false };
  return { transport, request, controller, log, diagnostics, inputs: async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) };
}
async function collect(messages: AsyncIterable<AmpStreamMessage>) {
  const result: AmpStreamMessage[] = [];
  for await (const message of messages) result.push(message);
  return result;
}

describe('CLI prompt recovery', () => {
  it('resumes the same thread after a transient failure without replaying the instruction or tool', async () => {
    const { transport, request, inputs } = setup();
    const messages = await collect(transport.execute(request));
    const received = await inputs();
    expect(received).toHaveLength(2);
    expect(received[0].prompt).toBe('original instruction');
    expect(received[1].prompt).toContain('Continue the interrupted turn');
    expect(received[1].prompt).not.toContain('original instruction');
    expect(received[1].args.slice(0, 3)).toEqual(['threads', 'continue', threadId]);
    expect(received[1].steer).toBe(false);
    expect(messages.filter((message) => message.is_error)).toHaveLength(0);
    expect(messages.at(-1)?.message?.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(messages.filter((message) => JSON.stringify(message.message?.content ?? []).includes('one side effect'))).toHaveLength(1);
  });

  it('bounds retries and preserves the original error when recovery fails', async () => {
    const { transport, request, inputs } = setup('always', 2);
    await expect(collect(transport.execute(request))).rejects.toThrow(transient);
    expect(await inputs()).toHaveLength(3);
  });

  it.each(['pre-echo', 'exit-zero'])('does not replay unacknowledged inputs: %s', async (scenario) => {
    const { transport, request, inputs } = setup(scenario);
    await expect(collect(transport.execute(request))).rejects.toThrow(scenario === 'auth' ? 'Unauthorized' : scenario === 'parameter' ? 'Invalid model parameter' : scenario === 'subscription' ? 'model subscription expired' : scenario === 'pre-echo' ? transient : 'exited with code 0');
    expect(await inputs()).toHaveLength(1);
  });

  it.each(['overload', 'unknown', 'exit-after-echo'])('prioritizes recovery for acknowledged execution errors: %s', async (scenario) => {
    const { transport, request, inputs } = setup(scenario);
    const messages = await collect(transport.execute(request));
    expect(messages.at(-1)?.message?.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(await inputs()).toHaveLength(2);
  });

  it.each(['auth', 'parameter', 'subscription'])('retries model errors before reporting the exhausted result: %s', async (scenario) => {
    const { transport, request, inputs } = setup(scenario, 1);
    await expect(collect(transport.execute(request))).rejects.toThrow(scenario === 'auth' ? 'Unauthorized' : scenario === 'parameter' ? 'Invalid model parameter' : 'subscription expired');
    expect(await inputs()).toHaveLength(2);
  });

  it('records the overloaded failure and the complete recovery sequence without raw inputs', async () => {
    const { transport, request, diagnostics } = setup('overload');
    request.prompt = 'PRIVATE_PROMPT_SENTINEL';
    await collect(transport.execute(request));
    expect(diagnostics.map((entry) => entry.event)).toEqual(['execution_started', 'failure', 'retry_scheduled', 'retry_started', 'recovery_resumed', 'recovered']);
    expect(diagnostics[1]).toMatchObject({ failureKind: 'overloaded', reason: 'retry', promptAcknowledged: true });
    expect(diagnostics[1]?.failureFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(new Set(diagnostics.map((entry) => entry.executionId)).size).toBe(1);
    expect(diagnostics.at(-1)?.ampThreadId).toBe(threadId);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('PRIVATE_PROMPT_SENTINEL');
    expect(serialized).not.toContain(overload);
  });

  it.each([
    { scenario: 'always', maxRetries: 0, reason: 'max_retries' },
    { scenario: 'pre-echo', maxRetries: 3, reason: 'input_unacknowledged' },
  ])('explains why recovery stopped: $reason', async ({ scenario, maxRetries, reason }) => {
    const { transport, request, diagnostics } = setup(scenario, maxRetries);
    await expect(collect(transport.execute(request))).rejects.toThrow(transient);
    expect(diagnostics.at(-1)).toMatchObject({ event: 'stopped', reason });
  });

  it('keeps unknown failure text out of the retry diagnostics', async () => {
    const { transport, request, diagnostics } = setup('unknown');
    await collect(transport.execute(request));
    expect(diagnostics[1]?.failureKind).toBe('unknown');
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_ERROR_SENTINEL');
  });

  it('recovers an empty error without replaying the original instruction', async () => {
    const { transport, request, inputs, diagnostics } = setup('empty-error', 1);
    await collect(transport.execute(request));
    const received = await inputs();
    expect(received).toHaveLength(2);
    expect(received[1].prompt).toContain('Continue the interrupted turn');
    expect(received[1].args.slice(0, 3)).toEqual(['threads', 'continue', threadId]);
    expect(diagnostics.some((entry) => entry.event === 'retry_scheduled')).toBe(true);
  });

  it.each(['delayed-recovery', 'empty-progress-recovery'])('terminates a recovery without meaningful output before the deadline: %s', async (scenario) => {
    const { transport, request, diagnostics } = setup(scenario, 3, 1, { maxDurationMs: 300 });
    await expect(collect(transport.execute(request))).rejects.toThrow('automatic retry window exhausted');
    expect(diagnostics.at(-1)).toMatchObject({ event: 'stopped', reason: 'window_expired' });
    expect(diagnostics.some((entry) => entry.event === 'recovered')).toBe(false);
  });

  it('lets healthy recovered execution finish beyond the recovery waiting window', async () => {
    const { transport, request, diagnostics } = setup('healthy-recovery', 3, 1, { maxDurationMs: 300 });
    const messages = await collect(transport.execute(request));
    expect(messages.at(-1)?.message?.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(diagnostics.at(-1)?.event).toBe('recovered');
  });

  it('defaults to a 30-second first wait and a 50-attempt ceiling without blocking cancellation', async () => {
    const { request, controller, log } = setup('always');
    const previous = process.env.AMP_ACP_MAX_RETRIES;
    const previousWindow = process.env.AMP_ACP_RETRY_WINDOW_SECONDS;
    delete process.env.AMP_ACP_MAX_RETRIES;
    delete process.env.AMP_ACP_RETRY_WINDOW_SECONDS;
    let transport: AmpTransport;
    try {
      transport = createCliTransport(process.execPath, [fixture, log, 'always'], true);
      transports.push(transport);
    } finally {
      if (previous === undefined) delete process.env.AMP_ACP_MAX_RETRIES; else process.env.AMP_ACP_MAX_RETRIES = previous;
      if (previousWindow === undefined) delete process.env.AMP_ACP_RETRY_WINDOW_SECONDS; else process.env.AMP_ACP_RETRY_WINDOW_SECONDS = previousWindow;
    }
    const iterator = transport.execute(request)[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.value?.retry) {
        expect(next.value.retry).toEqual({ attempt: 1, maxRetries: 50, delayMs: 30000 });
        break;
      }
      if (next.done) throw new Error('Missing recovery status');
    }
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('caps exponential waits at the configured interval', async () => {
    const { transport, request, inputs } = setup('always', 3, 2, { maxDelayMs: 3 });
    const waits: number[] = [];
    await expect((async () => {
      for await (const message of transport.execute(request)) if (message.retry) waits.push(message.retry.delayMs);
    })()).rejects.toThrow(transient);
    expect(waits).toEqual([2, 3, 3]);
    expect(await inputs()).toHaveLength(4);
  });

  it('limits the final wait to the recovery window and never starts a late attempt', async () => {
    const { transport, request, inputs, diagnostics } = setup('always', 50, 10000, { maxDurationMs: 40 });
    const waits: number[] = [];
    await expect((async () => {
      for await (const message of transport.execute(request)) if (message.retry) waits.push(message.retry.delayMs);
    })()).rejects.toThrow(transient);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(40);
    expect(diagnostics.at(-1)).toMatchObject({ event: 'stopped', reason: 'window_expired' });
    expect(await inputs()).toHaveLength(1);
  });

  it('can disable automatic recovery', async () => {
    const { transport, request, inputs } = setup('always', 0);
    await expect(collect(transport.execute(request))).rejects.toThrow(transient);
    expect(await inputs()).toHaveLength(1);
  });

  it('does not drop a steer whose acceptance is unknown', async () => {
    const { transport, request, inputs, diagnostics } = setup('pending-steer');
    const iterator = transport.execute(request)[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (JSON.stringify(next.value).includes('waiting for steer')) break;
      if (next.done) throw new Error('Missing initial output');
    }
    await transport.steer?.({ ...request, prompt: 'unacknowledged replacement', steer: true });
    await expect(collect({ [Symbol.asyncIterator]: () => iterator })).rejects.toThrow(transient);
    expect(await inputs()).toHaveLength(2);
    expect(diagnostics.at(-1)).toMatchObject({ event: 'stopped', reason: 'steer_unacknowledged' });
  });

  it('continues after an acknowledged steer and retains the same thread', async () => {
    const { transport, request, inputs } = setup('accepted-steer');
    const iterator = transport.execute(request)[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (JSON.stringify(next.value).includes('waiting for steer')) break;
      if (next.done) throw new Error('Missing initial output');
    }
    await transport.steer?.({ ...request, prompt: 'accepted replacement', steer: true });
    const messages = await collect({ [Symbol.asyncIterator]: () => iterator });
    expect(messages.at(-1)?.message?.content).toEqual([{ type: 'text', text: 'recovered' }]);
    const received = await inputs();
    expect(received).toHaveLength(3);
    expect(received[1]).toMatchObject({ prompt: 'accepted replacement', steer: true });
    expect(received[2].args.slice(0, 3)).toEqual(['threads', 'continue', threadId]);
  });

  it.each(['cancel', 'close'])('stops immediately during retry backoff: %s', async (action) => {
    const { transport, request, controller, inputs, diagnostics } = setup('always', 3, 10000);
    const iterator = transport.execute(request)[Symbol.asyncIterator]();
    // The nonterminal status tells the client that recovery is waiting.
    for (;;) {
      const next = await iterator.next();
      if (JSON.stringify(next.value).includes('retry')) break;
      if (next.done) throw new Error('Missing recovery status');
    }
    const pending = iterator.next();
    if (action === 'cancel') controller.abort(); else transport.closeAll?.();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await inputs()).toHaveLength(1);
    expect(diagnostics.at(-1)).toMatchObject({ event: 'cancelled', reason: action === 'cancel' ? 'cancelled' : 'connection_closed' });
  });
});

function connect(transport: AmpTransport) {
  const clientToAgent = new TransformStream<Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array>();
  const updates: SessionNotification[] = [];
  let notifyRetry!: () => void;
  const nextRetry = new Promise<void>((resolve) => { notifyRetry = resolve; });
  const client = new ClientSideConnection(() => ({
    sessionUpdate: async (notification) => {
      updates.push(notification);
      if (notification.update.sessionUpdate === 'agent_thought_chunk') notifyRetry();
    },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  }), ndJsonStream(clientToAgent.writable, agentToClient.readable));
  new AgentSideConnection((connection) => new AmpAcpAgent(connection, transport, {
    modeCatalog: async () => ({ modes: BUILTIN_AMP_MODES }),
    threadStore: new FileThreadMappingStore(path.join(directory, 'state')),
  }), ndJsonStream(agentToClient.writable, clientToAgent.readable));
  return { client, updates, nextRetry };
}

describe('ACP failure and recovery reporting', () => {
  it('keeps a recovered turn successful and reports retry progress separately from its answer', async () => {
    const { transport } = setup();
    const { client, updates } = connect(transport);
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: directory, mcpServers: [] });
    expect((await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'original instruction' }] })).stopReason).toBe('end_turn');
    expect(updates.some(({ update }) => update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text' && update.content.text.includes('retry 1/3'))).toBe(true);
    const answer = updates.flatMap(({ update }) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []);
    expect(answer).toEqual(['recovered']);
  });

  it('lets the client cancel recovery and submit a replacement using the ACP fallback contract', async () => {
    const { transport, inputs } = setup('once', 3, 10000);
    const { client, nextRetry } = connect(transport);
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: directory, mcpServers: [] });
    const primary = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'original instruction' }] });
    await nextRetry;
    const replacement = { sessionId: session.sessionId, prompt: [{ type: 'text' as const, text: 'replacement instruction' }] };
    await expect(client.prompt(replacement)).rejects.toMatchObject({
      code: -32602, message: expect.stringContaining('already in flight'),
    });
    await client.cancel({ sessionId: session.sessionId });
    expect((await primary).stopReason).toBe('cancelled');
    expect((await client.prompt(replacement)).stopReason).toBe('end_turn');
    const received = await inputs();
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ prompt: 'replacement instruction', steer: false });
    expect(received[1].args.slice(0, 3)).toEqual(['threads', 'continue', threadId]);
  });

  it.each(['cli', 'sdk'] as const)('rejects a failed result instead of marking the turn successful: %s', async (name) => {
    const transport = name === 'cli' ? setup('always', 0).transport : {
      name: 'sdk' as const,
      async *execute() { yield { type: 'result', is_error: true, error: transient }; },
    };
    const { client, updates } = connect(transport);
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: directory, mcpServers: [] });
    await expect(client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'original instruction' }] })).rejects.toThrow(transient);
    expect(updates.some(({ update }) => update.sessionUpdate === 'agent_message_chunk')).toBe(false);
  });
});

describe('ACP authentication failures', () => {
  it('keeps the authentication-required response and does not retry', async () => {
    const { transport, inputs } = setup('auth', 0);
    const { client } = connect(transport);
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: directory, mcpServers: [] });
    await expect(client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'original instruction' }] })).rejects.toMatchObject({ code: -32000 });
    expect(await inputs()).toHaveLength(1);
  });
});
