import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { AgentSideConnection, ClientSideConnection, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AmpAcpAgent } from './server.js';
import { BUILTIN_AMP_MODES } from './amp-modes.js';
import { createAmpTransport, createCliTransport, type AmpTransport } from './amp-transport.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';

let fixtureDir: string;
let fixturePath: string;
let fixtureSequence = 0;
const transports: AmpTransport[] = [];

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'amp-native-steer-test-'));
  fixturePath = path.join(fixtureDir, 'amp.mjs');
  await writeFile(fixturePath, `
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
let initialized = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  const text = input.message.content.filter((part) => part.type === 'text');
  const prompt = text.map((part) => part.text).join('');
  const firstInput = !initialized;
  if (!initialized) {
    initialized = true;
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'T-01a03c00-e608-7007-8181-5c1cc56757be' }));
  }
  const echo = () => console.log(JSON.stringify({ type: 'user', message: { content: text } }));
  const reply = (stopReason) => console.log(JSON.stringify({ type: 'assistant', message: {
    content: [{ type: 'text', text: JSON.stringify({ prompt, steer: input.steer, pid: process.pid, content: input.message.content }) },
      ...(stopReason === 'tool_use' ? [{ type: 'tool_use', id: 'old-tool', name: 'Bash', input: { cmd: 'echo ready' } }] : [])],
    stop_reason: stopReason,
  } }));
  const skippedMarker = process.argv.find((arg) => arg.startsWith('--skip-marker='))?.slice('--skip-marker='.length);
  if (firstInput && skippedMarker && !existsSync(skippedMarker)) {
    writeFileSync(skippedMarker, 'skipped');
    return;
  }
  if (prompt === 'deferred') {
    console.log(JSON.stringify({ type: 'assistant', message: { content: [], stop_reason: 'end_turn' } }));
    setTimeout(() => { echo(); reply('end_turn'); }, 10);
    return;
  }
  if (!prompt && process.argv.includes('--defer-image')) {
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'ready' }] }, parent_tool_use_id: null }));
    console.log(JSON.stringify({ type: 'user', message: { content: [] }, parent_tool_use_id: 'sub-tool' }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [], stop_reason: 'end_turn' } }));
    setTimeout(() => { echo(); reply('end_turn'); }, 10);
    return;
  }
  echo();
  if (prompt === 'primary' && process.argv.includes('--defer-image')) { reply('tool_use'); return; }
  reply(prompt === 'finish' || process.argv.includes('--complete-steer') ? 'end_turn' : null);
});
`);
});

afterEach(() => {
  for (const transport of transports.splice(0)) transport.closeAll?.();
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

function connect(options: { skipPrimaryEcho?: boolean; completeSteer?: boolean; deferImage?: boolean; preserveCancelledProcess?: boolean; transport?: AmpTransport } = {}) {
  const transport = options.transport ?? createCliTransport(process.execPath,
    [fixturePath, ...(options.skipPrimaryEcho ? ['--skip-marker=' + path.join(fixtureDir, 'skipped-' + ++fixtureSequence)] : []), ...(options.completeSteer ? ['--complete-steer'] : []), ...(options.deferImage ? ['--defer-image'] : [])],
    options.preserveCancelledProcess ?? true);
  transports.push(transport);
  const clientToAgent = new TransformStream<Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array>();
  const updates: SessionNotification[] = [];
  const waiting: (() => void)[] = [];
  const client = new ClientSideConnection(() => ({
    sessionUpdate: async (notification) => {
      updates.push(notification);
      if (notification.update.sessionUpdate === 'agent_message_chunk') {
        waiting.shift()?.();
      }
    },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  }), ndJsonStream(clientToAgent.writable, agentToClient.readable));
  new AgentSideConnection((connection) => new AmpAcpAgent(connection, transport, {
    modeCatalog: async () => ({ modes: BUILTIN_AMP_MODES }),
    threadStore: new FileThreadMappingStore(path.join(fixtureDir, 'state')),
    orbTransport: transport,
  }), ndJsonStream(agentToClient.writable, clientToAgent.readable));
  return {
    client, updates,
    nextOutput: () => new Promise<void>((resolve) => { waiting.push(resolve); }),
  };
}

function replies(updates: SessionNotification[]) {
  return updates.map(({ update }) => update)
    .filter((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
    .map((update) => JSON.parse(update.content.text));
}

describe('native ACP steering', () => {
  it('injects a concurrent prompt without cancelling the active turn or restarting Amp', async () => {
    const { client, updates, nextOutput } = connect();
    const initialized = await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(initialized._meta?.midTurnSteering).toBe(true);
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    let primaryFinished = false;
    const firstOutput = nextOutput();
    const primary = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'primary' }] })
      .then((result) => { primaryFinished = true; return result; });
    await firstOutput;

    const injectedOutput = nextOutput();
    const injected = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'replacement' }] });
    expect(injected.stopReason).toBe('end_turn');
    await injectedOutput;
    expect(primaryFinished).toBe(false);
    expect(replies(updates)[1]).toMatchObject({ prompt: 'replacement', steer: true, pid: replies(updates)[0].pid });

    const final = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'finish' }] });
    expect(final.stopReason).toBe('end_turn');
    expect((await primary).stopReason).toBe('end_turn');
    expect(replies(updates).at(-1)).toMatchObject({ prompt: 'finish', steer: true });
  });

  it('does not finish on an earlier terminal response before the steer is echoed', async () => {
    const { client, updates, nextOutput } = connect();
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    const firstOutput = nextOutput();
    const primary = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'primary' }] });
    await firstOutput;

    await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'deferred' }] });
    expect((await primary).stopReason).toBe('end_turn');
    expect(replies(updates).at(-1)).toMatchObject({ prompt: 'deferred', steer: true });
  });

  it('accepts a steer that supersedes the primary before its first echo', async () => {
    const { client, updates } = connect({ skipPrimaryEcho: true });
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    const primary = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'primary' }] });
    await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'finish' }] });

    expect((await primary).stopReason).toBe('end_turn');
    expect(replies(updates)).toMatchObject([{ prompt: 'finish', steer: true }]);
  });

  it.each([
    { prompt: [{ type: 'text' as const, text: 'same input' }] },
    { prompt: [{ type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY0QAAAAASUVORK5CYII=' }] },
  ])('falls back without hanging when an identical steer precedes the first echo: %j', async ({ prompt }) => {
    const { client, updates } = connect({ skipPrimaryEcho: true, completeSteer: true });
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    const primary = client.prompt({ sessionId: session.sessionId, prompt });
    while (!(await client.extMethod('amp-acp/session/native-metadata', { sessionId: session.sessionId })).ampThreadId) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await expect(client.prompt({ sessionId: session.sessionId, prompt }))
      .rejects.toMatchObject({ code: -32602, message: expect.stringContaining('already in flight') });
    await client.cancel({ sessionId: session.sessionId });
    expect((await primary).stopReason).toBe('cancelled');
    expect((await client.prompt({ sessionId: session.sessionId, prompt })).stopReason).toBe('end_turn');
    expect(replies(updates)).toMatchObject([{ steer: false }]);
  });

  it('delivers repeated text and image-only steers in order on the original process', async () => {
    const { client, updates, nextOutput } = connect();
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    const firstOutput = nextOutput();
    const primary = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'primary' }] });
    await firstOutput;
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY0QAAAAASUVORK5CYII=' };

    for (const prompt of [[{ type: 'text' as const, text: 'repeated' }], [{ type: 'text' as const, text: 'repeated' }], [image]]) {
      const output = nextOutput();
      await client.prompt({ sessionId: session.sessionId, prompt });
      await output;
    }
    await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'finish' }] });
    expect((await primary).stopReason).toBe('end_turn');
    const received = replies(updates);
    expect(received.map((reply) => reply.prompt)).toEqual(['primary', 'repeated', 'repeated', '', 'finish']);
    expect(received.slice(1).every((reply) => reply.steer === true && reply.pid === received[0].pid)).toBe(true);
    expect(received[3].content).toEqual([{
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data },
    }]);
  });

  it('waits for the image steer echo after tool results, subagent echoes, and an old terminal', async () => {
    const { client, updates, nextOutput } = connect({ deferImage: true });
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    const firstOutput = nextOutput();
    const primary = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'primary' }] });
    await firstOutput;
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY0QAAAAASUVORK5CYII=' };
    await client.prompt({ sessionId: session.sessionId, prompt: [image] });

    expect((await primary).stopReason).toBe('end_turn');
    expect(replies(updates).map((reply) => reply.prompt)).toEqual(['primary', '']);
    expect(replies(updates).at(-1)).toMatchObject({ steer: true, content: [{ type: 'image' }] });
  });

  it('keeps standard cancellation effective after a native steer', async () => {
    const { client, updates, nextOutput } = connect({ preserveCancelledProcess: false });
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    const firstOutput = nextOutput();
    const primary = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'primary' }] });
    await firstOutput;
    await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'replacement' }] });
    await client.cancel({ sessionId: session.sessionId });
    expect((await primary).stopReason).toBe('cancelled');

    await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'finish' }] });
    expect(replies(updates).at(-1).pid).not.toBe(replies(updates)[0].pid);
    expect(replies(updates).at(-1).steer).toBe(false);
  });

  it('does not declare native steering for SDK execution', async () => {
    const { client } = connect({ transport: createAmpTransport('sdk') });
    const initialized = await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(initialized._meta?.midTurnSteering).toBe(false);
  });

  it('rejects concurrent Orb prompts with the fallback signal and keeps the primary cancellable', async () => {
    const { client, nextOutput } = connect();
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    await client.setSessionConfigOption({ sessionId: session.sessionId, configId: 'execution-environment', value: 'orb' });
    const firstOutput = nextOutput();
    const primary = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'primary' }] });
    await firstOutput;

    await expect(client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'replacement' }] }))
      .rejects.toMatchObject({ code: -32602, message: expect.stringContaining('already in flight') });
    await client.cancel({ sessionId: session.sessionId });
    expect((await primary).stopReason).toBe('cancelled');
  });
});
