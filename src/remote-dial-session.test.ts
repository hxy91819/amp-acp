import { expect, it } from 'bun:test';
import { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { createAmpModeCatalog } from './amp-modes.js';
import { createRemoteDialReader } from './amp-remote-dial.js';
import { AmpAcpAgent } from './server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

it('uses the cached remote Dial over ACP, refreshes after expiry, and preserves existing session modes', async () => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'amp-dial-session-'));
  let now = Date.now();
  let dial = ['remote-reviewer', 'remote-coder'];
  let offline = false;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => offline
      ? new Response('', { status: 503 })
      : Response.json({ ok: true, result: { dialModes: dial } }),
  });
  const clientToAgent = new TransformStream();
  const agentToClient = new TransformStream();
  const executedModes: (string | undefined)[] = [];
  const client = new ClientSideConnection(() => ({
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  }), ndJsonStream(clientToAgent.writable, agentToClient.readable));
  new AgentSideConnection((connection) => new AmpAcpAgent(connection, {
    name: 'cli',
    async *execute(request) {
      executedModes.push(request.options.mode);
      yield { type: 'result', is_error: false };
    },
  }, {
    modeCatalog: createAmpModeCatalog({
      modeSource: 'remote',
      readRemoteDial: createRemoteDialReader({ url: server.url.href, apiKey: 'test-token', cacheDirectory, now: () => now }),
      trustPluginDiscovery: false,
    }),
  }), ndJsonStream(agentToClient.writable, clientToAgent.readable));
  try {
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const first = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(first.configOptions?.find((option) => option.id === 'amp-mode')).toMatchObject({
      currentValue: 'remote-reviewer',
      options: [{ value: 'remote-reviewer' }, { value: 'remote-coder' }],
    });
    await client.setSessionConfigOption({ sessionId: first.sessionId, configId: 'amp-mode', value: 'remote-coder' });
    await client.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    expect(executedModes).toEqual(['remote-coder']);

    dial = ['remote-new', 'remote-reviewer'];
    const cached = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(cached.configOptions?.find((option) => option.id === 'amp-mode')).toMatchObject({
      options: [{ value: 'remote-reviewer' }, { value: 'remote-coder' }],
    });
    now += 24 * 60 * 60 * 1000;
    const next = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(next.configOptions?.find((option) => option.id === 'amp-mode')).toMatchObject({
      currentValue: 'remote-new',
      options: [{ value: 'remote-new' }, { value: 'remote-reviewer' }],
    });
    // The existing thread continues with its original mode even after it leaves the Dial.
    await client.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'continue' }] });
    expect(executedModes).toEqual(['remote-coder', 'remote-coder']);
    offline = true;
    now += 24 * 60 * 60 * 1000;
    await expect(client.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow('Remote Amp Dial discovery failed');
  } finally {
    server.stop(true);
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
