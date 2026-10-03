import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AgentSideConnection, ClientSideConnection, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AmpAcpAgent } from './server.js';
import { BUILTIN_AMP_MODES } from './amp-modes.js';
import type { AmpExecutionRequest, AmpTransport } from './amp-transport.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';

const sourceThreadId = 'T-01234567-89ab-cdef-0123-456789abcdef';
const sourceSessionId = 'S-original-abcdef';
let stateDir: string;
let requests: AmpExecutionRequest[];
let updates: SessionNotification[];
let failNext: boolean;
let continueLatest: string | undefined;

function connect(transportName: 'cli' | 'sdk' = 'cli', overrideTransport?: AmpTransport) {
  const threads = new Map<string, string>();
  const transport: AmpTransport = overrideTransport ?? {
    name: transportName,
    async *execute(request) {
      requests.push(request);
      if (failNext) {
        failNext = false;
        throw new Error('fixture failed before creating a thread');
      }
      const threadId = typeof request.options.continue === 'string'
        ? request.options.continue
        : threads.get(request.sessionId) ?? `T-${randomUUID()}`;
      threads.set(request.sessionId, threadId);
      yield { type: 'system', session_id: threadId };
      yield { type: 'user', message: { content: typeof request.prompt === 'string'
        ? [{ type: 'text', text: request.prompt }]
        : request.prompt.filter((part) => part.type === 'text') } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
    },
  };
  const outgoing = new TransformStream<Uint8Array>();
  const incoming = new TransformStream<Uint8Array>();
  const client = new ClientSideConnection(() => ({
    sessionUpdate: async (update) => { updates.push(update); },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  }), ndJsonStream(outgoing.writable, incoming.readable));
  new AgentSideConnection((connection) => new AmpAcpAgent(connection, transport, {
    threadStore: new FileThreadMappingStore(stateDir),
    orbTransport: transport,
    modeCatalog: async () => ({ modes: BUILTIN_AMP_MODES }),
    exportThread: async () => [],
    replayRetry: { attempts: 1, delayMs: 0 },
  }), ndJsonStream(incoming.writable, outgoing.readable));
  return client;
}

beforeEach(async () => {
  requests = [];
  updates = [];
  failNext = false;
  continueLatest = process.env.AMP_ACP_CONTINUE_LATEST;
  delete process.env.AMP_ACP_CONTINUE_LATEST;
  stateDir = await mkdtemp(path.join(tmpdir(), 'amp-context-fork-'));
  await new FileThreadMappingStore(stateDir).save({
    sessionId: sourceSessionId, threadId: sourceThreadId,
    mode: 'bypass', model: 'high', executor: 'local', cwd: '/tmp/source',
  });
});

afterEach(async () => {
  if (continueLatest === undefined) delete process.env.AMP_ACP_CONTINUE_LATEST;
  else process.env.AMP_ACP_CONTINUE_LATEST = continueLatest;
  await rm(stateDir, { recursive: true, force: true });
});

describe('ACP context forks', () => {
  it('creates an idle durable fork and references the parent only on its first prompt', async () => {
    const client = connect();
    const initialized = await client.initialize({ protocolVersion: 1 });
    expect(initialized.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
    const fork = await client.unstable_forkSession({ sessionId: sourceSessionId, cwd: '/tmp/fork', mcpServers: [] });
    expect(fork.sessionId).not.toBe(sourceSessionId);
    expect(requests).toEqual([]);
    expect(fork.configOptions?.find((option) => option.id === 'amp-mode')?.currentValue).toBe('high');
    expect(await client.extMethod('amp-acp/session/native-metadata', { sessionId: fork.sessionId }))
      .toMatchObject({ ampThreadId: null });
    await expect(client.extMethod('amp-acp/thread/set-archived', {
      sessionId: fork.sessionId, threadId: sourceThreadId, archived: true,
    })).rejects.toThrow('No durable Amp thread mapping');

    const restarted = connect();
    await restarted.resumeSession({ sessionId: fork.sessionId, cwd: '/tmp/fork', mcpServers: [
      { name: 'fixture', command: 'fixture-mcp', args: [], env: [] },
    ] });
    process.env.AMP_ACP_CONTINUE_LATEST = '1';
    await restarted.prompt({ sessionId: fork.sessionId, prompt: [{ type: 'text', text: 'try another approach' }] });
    expect(requests[0]?.options).toMatchObject({ cwd: '/tmp/fork', mode: 'high', dangerouslyAllowAll: true,
      mcpConfig: { fixture: { command: 'fixture-mcp', args: [] } } });
    expect(requests[0]?.options.continue).toBeUndefined();
    expect(requests[0]?.prompt).toContain(`@${sourceThreadId}`);
    expect(requests[0]?.prompt).toContain('try another approach');
    const forkThreadId = (await new FileThreadMappingStore(stateDir).load(fork.sessionId))?.threadId;
    expect(forkThreadId).toMatch(/^T-/);
    expect(forkThreadId).not.toBe(sourceThreadId);
    expect(updates.filter(({ update }) => update.sessionUpdate === 'user_message_chunk').map(({ update }) =>
      update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text' ? update.content.text : ''))
      .toEqual(['try another approach']);

    const resumed = connect();
    await resumed.loadSession({ sessionId: fork.sessionId, cwd: '/tmp/fork', mcpServers: [] });
    await resumed.prompt({ sessionId: fork.sessionId, prompt: [{ type: 'text', text: 'next' }] });
    expect(requests[1]?.options.continue).toBe(forkThreadId);
    expect(requests[1]?.prompt).toBe('next');
    await resumed.resumeSession({ sessionId: sourceSessionId, cwd: '/tmp/source', mcpServers: [] });
    await resumed.prompt({ sessionId: sourceSessionId, prompt: [{ type: 'text', text: 'original' }] });
    expect(requests[2]?.options.continue).toBe(sourceThreadId);
  });

  it('advertises /init on the newly forked session', async () => {
    const client = connect();
    const fork = await client.unstable_forkSession({ sessionId: sourceSessionId, cwd: '/tmp/fork', mcpServers: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(updates.find((notification) => notification.sessionId === fork.sessionId
      && notification.update.sessionUpdate === 'available_commands_update')?.update)
      .toMatchObject({ availableCommands: [{ name: 'init' }] });
  });

  it('retains the source reference when retrying before cancelled execution has finished', async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transport: AmpTransport = {
      name: 'cli',
      async *execute(request) {
        requests.push(request);
        if (requests.length === 1) {
          request.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
          started.resolve();
          await release.promise;
          return;
        }
        yield { type: 'system', session_id: `T-${randomUUID()}` };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'retried' }] } };
      },
    };
    const client = connect('cli', transport);
    const fork = await client.unstable_forkSession({ sessionId: sourceSessionId, cwd: '/tmp/fork', mcpServers: [] });
    const first = client.prompt({ sessionId: fork.sessionId, prompt: [{ type: 'text', text: 'first' }] });
    try {
      await started.promise;
      await client.cancel({ sessionId: fork.sessionId });
      await aborted.promise;
      const retried = await client.prompt({ sessionId: fork.sessionId, prompt: [{ type: 'text', text: 'retry' }] });
      expect(retried.stopReason).toBe('end_turn');
      expect(requests[1]?.options.continue).toBeUndefined();
      expect(requests[1]?.prompt).toContain(`@${sourceThreadId}`);
      expect(requests[1]?.prompt).toContain('retry');
    } finally {
      release.resolve();
      expect((await first).stopReason).toBe('cancelled');
    }
  });

  it('preserves image input order and the reference after a pre-creation failure', async () => {
    const client = connect();
    const fork = await client.unstable_forkSession({ sessionId: sourceSessionId, cwd: '/tmp/fork', mcpServers: [] });
    await client.setSessionConfigOption({ sessionId: fork.sessionId, configId: 'amp-mode', value: 'low' });
    failNext = true;
    await expect(client.prompt({ sessionId: fork.sessionId, prompt: [{ type: 'text', text: 'retry me' }] }))
      .rejects.toThrow('Internal error');
    const restarted = connect();
    await restarted.loadSession({ sessionId: fork.sessionId, cwd: '/tmp/fork', mcpServers: [] });
    await restarted.prompt({ sessionId: fork.sessionId, prompt: [
      { type: 'text', text: 'before' },
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      { type: 'text', text: 'after' },
    ] });
    expect(requests[1]?.options.mode).toBe('low');
    expect(requests[1]?.options.continue).toBeUndefined();
    expect(requests[1]?.prompt).toEqual([
      { type: 'text', text: expect.stringContaining(`@${sourceThreadId}`) },
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
      { type: 'text', text: 'after' },
    ]);
    expect(updates.filter(({ update }) => update.sessionUpdate === 'user_message_chunk')).toHaveLength(2);
  });

  it('forks a live source using its latest settings without modifying it', async () => {
    const client = connect();
    await client.resumeSession({ sessionId: sourceSessionId, cwd: '/tmp/source', mcpServers: [] });
    await client.setSessionConfigOption({ sessionId: sourceSessionId, configId: 'permission', value: 'default' });
    const fork = await client.unstable_forkSession({ sessionId: sourceSessionId, cwd: '/tmp/fork', mcpServers: [] });
    expect(fork.configOptions?.find((option) => option.id === 'permission')?.currentValue).toBe('default');
    await client.prompt({ sessionId: fork.sessionId, prompt: [{ type: 'text', text: 'fork' }] });
    expect(requests[0]?.options.continue).toBeUndefined();
    expect((await new FileThreadMappingStore(stateDir).load(sourceSessionId))?.threadId).toBe(sourceThreadId);
  });

  it('inherits Orb execution and sends the source reference through the SDK transport', async () => {
    await new FileThreadMappingStore(stateDir).save({
      sessionId: sourceSessionId, threadId: sourceThreadId, executor: 'orb', model: 'medium',
    });
    const client = connect('sdk');
    const fork = await client.unstable_forkSession({ sessionId: sourceSessionId, cwd: '/tmp/orb', mcpServers: [] });
    await client.prompt({ sessionId: fork.sessionId, prompt: [{ type: 'text', text: 'orb fork' }] });
    expect(requests[0]?.options.executor).toBe('orb');
    expect(requests[0]?.options.continue).toBeUndefined();
    expect(requests[0]?.prompt).toContain(`@${sourceThreadId}`);
  });

  it('retains context when an idle fork is forked again', async () => {
    const client = connect();
    const first = await client.unstable_forkSession({ sessionId: sourceSessionId, cwd: '/tmp/first', mcpServers: [] });
    const restarted = connect();
    const second = await restarted.unstable_forkSession({ sessionId: first.sessionId, cwd: '/tmp/second', mcpServers: [] });
    await restarted.prompt({ sessionId: second.sessionId, prompt: [{ type: 'text', text: 'second' }] });
    expect(requests[0]?.prompt).toContain(`@${sourceThreadId}`);
    expect(requests[0]?.options.continue).toBeUndefined();
  });

  it('rejects missing or unstarted sources without launching Amp', async () => {
    const client = connect();
    await expect(client.unstable_forkSession({ sessionId: 'S-missing-abcdef', cwd: '/tmp', mcpServers: [] }))
      .rejects.toThrow('No Amp thread context');
    const empty = await client.newSession({ cwd: '/tmp', mcpServers: [] });
    await expect(client.unstable_forkSession({ sessionId: empty.sessionId, cwd: '/tmp', mcpServers: [] }))
      .rejects.toThrow('No Amp thread context');
    expect(requests).toEqual([]);
  });
});
