import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRemoteDialReader as createReader, type RemoteDialOptions } from './amp-remote-dial.js';

function createRemoteDialReader(options: RemoteDialOptions) {
  return createReader({ cacheDirectory: path.join(fixtureDir, 'cache'), ...options });
}

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
    let requests = 0;
    const url = serve((request) => {
      requests++;
      return request.headers.get('Authorization') === 'Bearer test-refreshed-token'
        ? Response.json({ ok: true, result: { dialModes: ['reviewer', 'specialist'] } })
        : Response.json({ ok: false, error: { code: 'auth-required' } });
    });
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
    expect(await createRemoteDialReader({ url, apiKey: '', dataDirectory: fixtureDir, command: '/nonexistent-amp' })(fixtureDir))
      .toEqual(['reviewer', 'specialist']);
    expect(requests).toBe(2);
  });

  it('rejects invalid explicit credentials without running Amp or exposing the server response', async () => {
    const url = serve(() => new Response('private account data', { status: 401 }));
    const read = createRemoteDialReader({ url, apiKey: 'test-invalid-token', command: '/nonexistent-amp' });
    await expect(read(fixtureDir)).rejects.toThrow('Amp authentication expired or was rejected.');
  });

  it.each([undefined, null, [], [42], [''], ['reviewer', null]].map((modes) => [modes]))('rejects missing or invalid saved Dial: %j', async (dialModes) => {
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

describe('remote Dial cache', () => {
  const day = 24 * 60 * 60 * 1000;
  const defaultTtl = 5 * 60 * 1000;

  it('reuses the default 5-minute cache across readers and directories, then refreshes at expiry', async () => {
    let now = Date.now();
    let requests = 0;
    const url = serve(() => Response.json({ ok: true, result: { dialModes: [`mode-${++requests}`] } }));
    const options = { url, apiKey: 'test-token', now: () => now };
    expect(await createRemoteDialReader(options)(fixtureDir)).toEqual(['mode-1']);
    now += defaultTtl - 1;
    expect(await createRemoteDialReader(options)(tmpdir())).toEqual(['mode-1']);
    expect(requests).toBe(1);
    now++;
    expect(await createRemoteDialReader(options)(fixtureDir)).toEqual(['mode-2']);
    expect(requests).toBe(2);
  });

  it('persists across independent adapter processes', async () => {
    let requests = 0;
    const url = serve(() => { requests++; return Response.json({ ok: true, result: { dialModes: ['shared'] } }); });
    const options = { url, apiKey: 'test-token', cacheDirectory: path.join(fixtureDir, 'process-cache') };
    const run = async () => {
      const script = `import { createRemoteDialReader } from ${JSON.stringify(new URL('./amp-remote-dial.ts', import.meta.url).href)};
console.log(JSON.stringify(await createRemoteDialReader(${JSON.stringify(options)})(process.cwd())));`;
      const child = Bun.spawn([process.execPath, '--eval', script], { cwd: fixtureDir, stdout: 'pipe', stderr: 'pipe' });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(errors).toBe('');
      expect(code).toBe(0);
      return JSON.parse(output);
    };
    expect(await run()).toEqual(['shared']);
    expect(await run()).toEqual(['shared']);
    expect(requests).toBe(1);
  });

  it('isolates credentials and service addresses without persisting secrets or account metadata', async () => {
    const cacheDirectory = path.join(fixtureDir, 'identity-cache');
    let requests = 0;
    const url = serve((request) => {
      requests++;
      return Response.json({ ok: true, result: {
        dialModes: [request.headers.get('Authorization') === 'Bearer secret-account-a' ? 'account-a' : 'account-b'],
        email: 'private@example.invalid',
      } });
    });
    const readA = createRemoteDialReader({ url, apiKey: 'secret-account-a', cacheDirectory });
    expect(await readA(fixtureDir)).toEqual(['account-a']);
    expect(await createRemoteDialReader({ url, apiKey: 'secret-account-b', cacheDirectory })(fixtureDir)).toEqual(['account-b']);
    expect(await readA(fixtureDir)).toEqual(['account-a']);
    expect(requests).toBe(2);
    const otherURL = serve(() => Response.json({ ok: true, result: { dialModes: ['other-service'] } }));
    expect(await createRemoteDialReader({ url: otherURL, apiKey: 'secret-account-a', cacheDirectory })(fixtureDir)).toEqual(['other-service']);
    for (const filename of await readdir(cacheDirectory)) {
      const file = path.join(cacheDirectory, filename);
      const contents = await readFile(file, 'utf8');
      expect(filename + contents).not.toContain('secret-account');
      expect(contents).not.toContain('private@example.invalid');
      expect(Object.keys(JSON.parse(contents)).sort()).toEqual(['dialModes', 'fetchedAt', 'version']);
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('coalesces concurrent cache misses and returns independent lists', async () => {
    let requests = 0;
    const url = serve(async () => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({ ok: true, result: { dialModes: ['shared'] } });
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => createRemoteDialReader({ url, apiKey: 'test-token' })(fixtureDir)));
    expect(requests).toBe(1);
    results[0]!.push('caller-change');
    expect(results[1]).toEqual(['shared']);
  });

  it('honors configured TTL and lets zero force refresh while updating the shared cache', async () => {
    const original = process.env.AMP_ACP_DIAL_CACHE_TTL_SECONDS;
    let now = Date.now();
    let requests = 0;
    const url = serve(() => Response.json({ ok: true, result: { dialModes: [`mode-${++requests}`] } }));
    const read = createRemoteDialReader({ url, apiKey: 'test-token', now: () => now });
    try {
      process.env.AMP_ACP_DIAL_CACHE_TTL_SECONDS = '172800';
      expect(await read(fixtureDir)).toEqual(['mode-1']);
      now += day;
      expect(await read(fixtureDir)).toEqual(['mode-1']);
      process.env.AMP_ACP_DIAL_CACHE_TTL_SECONDS = '0';
      expect(await read(fixtureDir)).toEqual(['mode-2']);
      expect(await read(fixtureDir)).toEqual(['mode-3']);
      process.env.AMP_ACP_DIAL_CACHE_TTL_SECONDS = '172800';
      expect(await read(fixtureDir)).toEqual(['mode-3']);
    } finally {
      if (original === undefined) delete process.env.AMP_ACP_DIAL_CACHE_TTL_SECONDS;
      else process.env.AMP_ACP_DIAL_CACHE_TTL_SECONDS = original;
    }
  });

  it('does not serve expired data on failure, and retries after failed concurrent refreshes', async () => {
    let now = Date.now();
    let offline = false;
    let requests = 0;
    const url = serve(async () => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return offline ? new Response('', { status: 503 }) : Response.json({ ok: true, result: { dialModes: [`mode-${requests}`] } });
    });
    const read = createRemoteDialReader({ url, apiKey: 'test-token', now: () => now });
    expect(await read(fixtureDir)).toEqual(['mode-1']);
    offline = true;
    expect(await read(fixtureDir)).toEqual(['mode-1']);
    now += defaultTtl;
    const results = await Promise.allSettled([read(fixtureDir), read(fixtureDir)]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(requests).toBe(2);
    offline = false;
    expect(await read(fixtureDir)).toEqual(['mode-3']);
  });

  it('repairs corrupt cache entries and ignores future timestamps', async () => {
    const cacheDirectory = path.join(fixtureDir, 'corrupt-cache');
    let requests = 0;
    const url = serve(() => Response.json({ ok: true, result: { dialModes: [`mode-${++requests}`] } }));
    const read = createRemoteDialReader({ url, apiKey: 'test-token', cacheDirectory });
    await read(fixtureDir);
    const filename = (await readdir(cacheDirectory))[0]!;
    for (const contents of [
      'broken JSON',
      JSON.stringify({ version: 1, fetchedAt: Date.now(), dialModes: [42] }),
      JSON.stringify({ version: 1, fetchedAt: Date.now() + day, dialModes: ['future'] }),
      JSON.stringify({ version: 2, fetchedAt: Date.now(), dialModes: ['unknown-format'] }),
    ]) {
      await writeFile(path.join(cacheDirectory, filename), contents);
      expect(await read(fixtureDir)).toEqual([`mode-${requests}`]);
    }
    expect(requests).toBe(5);
    expect((await readdir(cacheDirectory)).length).toBe(1);
  });

  it('still fetches when the cache directory is unavailable', async () => {
    const cacheDirectory = path.join(fixtureDir, 'not-a-directory');
    await writeFile(cacheDirectory, 'occupied');
    let requests = 0;
    const url = serve(() => { requests++; return Response.json({ ok: true, result: { dialModes: ['available'] } }); });
    const read = createRemoteDialReader({ url, apiKey: 'test-token', cacheDirectory });
    expect(await read(fixtureDir)).toEqual(['available']);
    expect(await read(fixtureDir)).toEqual(['available']);
    expect(requests).toBe(2);
  });

  it.each([-1, Infinity, NaN])('rejects invalid TTL %s before discovery', async (cacheTtlMs) => {
    await expect(createRemoteDialReader({ url: 'http://127.0.0.1:1', apiKey: 'test-token', cacheTtlMs })(fixtureDir))
      .rejects.toThrow('AMP_ACP_DIAL_CACHE_TTL_SECONDS must be a finite non-negative number.');
  });
});
