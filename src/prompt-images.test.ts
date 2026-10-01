import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { AgentSideConnection, ClientSideConnection, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AmpAcpAgent } from './server.js';
import { BUILTIN_AMP_MODES } from './amp-modes.js';
import { createAmpTransport, createCliTransport, type AmpTransport } from './amp-transport.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';

const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';
const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY0QAAAAASUVORK5CYII=';
const image = { type: 'image' as const, mimeType: 'image/png', data: pngData };
const ampImage = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngData } };
let fixtureDir: string;
let fixturePath: string;
const transports: AmpTransport[] = [];

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'amp-acp-image-test-'));
  fixturePath = path.join(fixtureDir, 'amp.mjs');
  await writeFile(fixturePath, `
import { createInterface } from 'node:readline';
let initialized = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (!initialized) {
    initialized = true;
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(threadId)} }));
  }
  // Amp omits images from user echoes, even when they were accepted on stdin.
  const text = input.message.content.filter((part) => part.type === 'text');
  console.log(JSON.stringify({ type: 'user', message: { content: text } }));
  if (text.some((part) => part.text === 'waiting')) return;
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: JSON.stringify({
      content: input.message.content, steer: input.steer, processId: process.pid,
      continued: process.argv.includes(${JSON.stringify(threadId)}),
    }) }], stop_reason: 'end_turn' },
  }));
});
`);
});

afterEach(() => {
  for (const transport of transports.splice(0)) transport.closeAll?.();
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

function connect(transport = createCliTransport(process.execPath, [fixturePath], true)) {
  transports.push(transport);
  const clientToAgent = new TransformStream<Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array>();
  const updates: SessionNotification[] = [];
  const client = new ClientSideConnection(() => ({
    sessionUpdate: async (notification) => { updates.push(notification); },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  }), ndJsonStream(clientToAgent.writable, agentToClient.readable));
  new AgentSideConnection((connection) => new AmpAcpAgent(connection, transport, {
    modeCatalog: async () => ({ modes: BUILTIN_AMP_MODES }),
    threadStore: new FileThreadMappingStore(path.join(fixtureDir, 'state')),
  }), ndJsonStream(agentToClient.writable, clientToAgent.readable));
  return { client, updates, transport };
}

function assistantText(updates: SessionNotification[]): string {
  return updates.map(({ update }) => update)
    .filter((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
    .map((update) => update.content.text)
    .join('');
}

describe('ACP image input to Amp CLI', () => {
  it('preserves image bytes and their position between text blocks', async () => {
    const { client, updates } = connect();
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    await client.prompt({ sessionId: session.sessionId, prompt: [
      { type: 'text', text: 'before' }, image, { type: 'text', text: 'after' },
    ] });

    expect(JSON.parse(assistantText(updates)).content).toEqual([
      { type: 'text', text: 'before' }, ampImage, { type: 'text', text: 'after' },
    ]);
  });

  it('does not advertise image input for the text-only SDK transport', async () => {
    const { client } = connect(createAmpTransport('sdk'));
    const initialized = await client.initialize({ protocolVersion: 1, clientCapabilities: {} });

    expect(initialized.agentCapabilities?.promptCapabilities?.image).toBe(false);
  });

  it('rejects SDK images without locking the session configuration', async () => {
    const { client } = connect(createAmpTransport('sdk'));
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });

    await expect(client.prompt({ sessionId: session.sessionId, prompt: [image] }))
      .rejects.toMatchObject({ code: -32602 });
    const config = await client.setSessionConfigOption({
      sessionId: session.sessionId, configId: 'amp-mode', value: 'high',
    });
    expect(config.configOptions.find((option) => option.id === 'amp-mode')?.currentValue).toBe('high');
  });

  it('reports unsupported image formats and accepts a valid image afterward', async () => {
    const { client, updates } = connect();
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });

    await expect(client.prompt({
      sessionId: session.sessionId,
      prompt: [{ ...image, mimeType: 'image/svg+xml' }],
    })).rejects.toMatchObject({ code: -32602 });
    await client.prompt({ sessionId: session.sessionId, prompt: [image] });
    expect(JSON.parse(assistantText(updates)).content).toEqual([ampImage]);
  });

  it('preserves consecutive image-only prompts on the same Amp process', async () => {
    const { client, updates } = connect();
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    await client.prompt({ sessionId: session.sessionId, prompt: [image] });
    const first = JSON.parse(assistantText(updates));
    updates.length = 0;

    await client.prompt({ sessionId: session.sessionId, prompt: [image, image] });
    const second = JSON.parse(assistantText(updates));
    expect(first.content).toEqual([ampImage]);
    expect(second.content).toEqual([ampImage, ampImage]);
    expect(second.processId).toBe(first.processId);
  });

  it('preserves images after the adapter runtime resumes a durable session', async () => {
    const first = connect();
    await first.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.client.newSession({ cwd: fixtureDir, mcpServers: [] });
    await first.client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'first' }] });
    first.transport.closeAll?.();

    const resumed = connect();
    await resumed.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await resumed.client.resumeSession({ sessionId: session.sessionId, cwd: fixtureDir, mcpServers: [] });
    await resumed.client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'resumed' }, image] });

    expect(JSON.parse(assistantText(resumed.updates))).toMatchObject({
      content: [{ type: 'text', text: 'resumed' }, ampImage], continued: true,
    });
  });

  it('preserves images when steering a cancelled active prompt', async () => {
    const { client, updates } = connect();
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    const waiting = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'waiting' }] });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (updates.some(({ update }) => update.sessionUpdate === 'user_message_chunk')) break;
      await Bun.sleep(5);
    }
    expect(updates.some(({ update }) => update.sessionUpdate === 'user_message_chunk')).toBe(true);
    await client.cancel({ sessionId: session.sessionId });
    expect((await waiting).stopReason).toBe('cancelled');
    updates.length = 0;

    await client.prompt({ sessionId: session.sessionId, prompt: [image] });
    expect(JSON.parse(assistantText(updates))).toMatchObject({ content: [ampImage], steer: true });
  });

  it('rejects Orb images before locking configuration or launching execution', async () => {
    const { client, updates } = connect();
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: fixtureDir, mcpServers: [] });
    await client.setSessionConfigOption({ sessionId: session.sessionId, configId: 'execution-environment', value: 'orb' });

    await expect(client.prompt({ sessionId: session.sessionId, prompt: [image] }))
      .rejects.toMatchObject({ code: -32602 });
    await client.setSessionConfigOption({ sessionId: session.sessionId, configId: 'execution-environment', value: 'local' });
    await client.prompt({ sessionId: session.sessionId, prompt: [image] });
    expect(JSON.parse(assistantText(updates)).content).toEqual([ampImage]);
  });
});
