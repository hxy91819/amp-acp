import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRemoteDialReader } from './amp-remote-dial.js';

let fixtureDir: string;
const servers: ReturnType<typeof Bun.serve>[] = [];
function serve(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  servers.push(server);
  return server.url.href;
}
beforeAll(async () => { fixtureDir = await mkdtemp(path.join(tmpdir(), 'amp-remote-dial-')); });
afterAll(async () => {
  for (const server of servers) server.stop(true);
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('remote Amp Dial', () => {
  it('authenticates getUserInfo and preserves remote order without substituting model IDs', async () => {
    let requestBody: unknown;
    let authorization: string | null = null;
    let requestedPath = '';
    const url = serve(async (request) => {
      requestBody = await request.json();
      authorization = request.headers.get('Authorization');
      requestedPath = new URL(request.url).pathname + new URL(request.url).search;
      return Response.json({ ok: true, result: {
        dialModes: ['specialist', 'reviewer'],
        modeModelOverrides: { medium: { main: { model: 'provider/custom-model' } } },
      } });
    });
    const read = createRemoteDialReader({ url, apiKey: 'test-token' });
    expect(await read(fixtureDir)).toEqual(['specialist', 'reviewer']);
    expect(authorization).toBe('Bearer test-token');
    expect(requestBody).toEqual({ method: 'getUserInfo', params: {} });
    expect(requestedPath).toBe('/api/internal?getUserInfo');
  });

  it('reads current stored login credentials on each request', async () => {
    let authorization: string | null = null;
    const url = serve((request) => {
      authorization = request.headers.get('Authorization');
      return Response.json({ ok: true, result: { dialModes: ['reviewer', 'specialist'] } });
    });
    const read = createRemoteDialReader({ url, apiKey: '', dataDirectory: fixtureDir });
    await writeFile(path.join(fixtureDir, 'secrets.json'), JSON.stringify({ [`apiKey@${url}`]: 'test-old-token' }));
    await read(fixtureDir);
    expect(authorization).toBe('Bearer test-old-token');
    await writeFile(path.join(fixtureDir, 'secrets.json'), JSON.stringify({ [`apiKey@${url}`]: 'test-new-token' }));
    await read(fixtureDir);
    expect(authorization).toBe('Bearer test-new-token');
  });

  it('lets Amp refresh an expired stored login and retries with the new credential', async () => {
    const url = serve((request) => request.headers.get('Authorization') === 'Bearer test-refreshed-token'
      ? Response.json({ ok: true, result: { dialModes: ['reviewer', 'specialist'] } })
      : Response.json({ ok: false, error: { code: 'auth-required' } }));
    const credentialPath = path.join(fixtureDir, 'secrets.json');
    const markerPath = path.join(fixtureDir, 'refresh-args.json');
    const cliPath = path.join(fixtureDir, 'refresh.mjs');
    await writeFile(credentialPath, JSON.stringify({ [`apiKey@${url}`]: 'test-expired-token' }));
    await writeFile(cliPath, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(credentialPath)}, ${JSON.stringify(JSON.stringify({ [`apiKey@${url}`]: 'test-refreshed-token' }))});
`);
    const read = createRemoteDialReader({ url, apiKey: '', dataDirectory: fixtureDir, command: 'node', commandArgs: [cliPath] });
    expect(await read(fixtureDir)).toEqual(['reviewer', 'specialist']);
    expect(JSON.parse(await readFile(markerPath, 'utf8'))).toEqual(['usage']);
  });

  it('rejects invalid explicit credentials without running Amp or exposing the server response', async () => {
    const url = serve(() => new Response('private account data', { status: 401 }));
    const read = createRemoteDialReader({ url, apiKey: 'test-invalid-token', command: '/nonexistent-amp' });
    await expect(read(fixtureDir)).rejects.toThrow('Amp authentication expired or was rejected.');
  });

  it.each([undefined, null, [], [42], [''], ['reviewer', null]])('rejects missing or invalid saved Dial: %j', async (dialModes) => {
    const url = serve(() => Response.json({ ok: true, result: { dialModes } }));
    await expect(createRemoteDialReader({ url, apiKey: 'test-token' })(fixtureDir)).rejects.toThrow();
  });

  it('reports HTTP failures without including account data or tokens', async () => {
    const url = serve(() => new Response('test-token private account data', { status: 503 }));
    await expect(createRemoteDialReader({ url, apiKey: 'test-token' })(fixtureDir))
      .rejects.toThrow('Remote Dial request failed (HTTP 503).');
  });

  it('bounds stalled requests and rejects malformed responses', async () => {
    const stalled = serve(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return Response.json({ ok: true, result: { dialModes: ['reviewer'] } });
    });
    await expect(createRemoteDialReader({ url: stalled, apiKey: 'test-token', timeoutMs: 20 })(fixtureDir))
      .rejects.toThrow('Unable to fetch the remote Amp Dial.');
    const malformed = serve(() => new Response('private account data, not JSON'));
    await expect(createRemoteDialReader({ url: malformed, apiKey: 'test-token' })(fixtureDir))
      .rejects.toThrow('Unable to fetch the remote Amp Dial.');
  });

  it('does not forward credentials through redirects', async () => {
    let received = false;
    const target = serve(() => { received = true; return new Response('unexpected'); });
    const url = serve(() => Response.redirect(target));
    await expect(createRemoteDialReader({ url, apiKey: 'test-token' })(fixtureDir)).rejects.toThrow();
    expect(received).toBe(false);
  });
});
