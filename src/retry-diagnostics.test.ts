import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRetryLogger } from './retry-diagnostics.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function temporary() { const dir = await mkdtemp(path.join(tmpdir(), 'amp-diagnostics-')); directories.push(dir); return dir; }

describe('retry diagnostic persistence', () => {
  it('writes timestamped JSONL with private permissions and retains one bounded backup', async () => {
    const directory = await temporary();
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = createRetryLogger(path.join(directory, 'logs'), 1024);
      for (let index = 0; index < 20; index++) logger({ event: 'retry_started', executionId: 'execution-' + index, attempt: index, elapsedMs: index });
      const files = await readdir(path.join(directory, 'logs'));
      expect(files).toHaveLength(2);
      const current = files.find((name) => !name.endsWith('.1'))!;
      const text = await readFile(path.join(directory, 'logs', current), 'utf8');
      const records = text.trim().split('\n').map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({ event: 'retry_started', executionId: 'execution-19', attempt: 19 });
      expect(Number.isFinite(Date.parse(records.at(-1).timestamp))).toBe(true);
      expect(stderr.mock.calls).toHaveLength(20);
      expect((await stat(path.join(directory, 'logs'))).mode & 0o777).toBe(0o700);
      for (const file of files) {
        const info = await stat(path.join(directory, 'logs', file));
        expect(info.size).toBeLessThanOrEqual(1024);
        expect(info.mode & 0o777).toBe(0o600);
        for (const line of (await readFile(path.join(directory, 'logs', file), 'utf8')).trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally { stderr.mockRestore(); }
  });

  it('preserves stderr diagnostics when the log directory is unwritable', async () => {
    const directory = await temporary();
    const blocker = path.join(directory, 'not-a-directory');
    await writeFile(blocker, 'fixture');
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = createRetryLogger(path.join(blocker, 'logs'));
      expect(() => logger({ event: 'completed', executionId: 'one', attempt: 0, elapsedMs: 1 })).not.toThrow();
      expect(() => logger({ event: 'completed', executionId: 'two', attempt: 0, elapsedMs: 2 })).not.toThrow();
      expect(stderr.mock.calls.filter(([line]) => String(line).includes('Unable to persist'))).toHaveLength(1);
      expect(stderr.mock.calls.filter(([line]) => String(line).startsWith('[amp-retry] {'))).toHaveLength(2);
    } finally { stderr.mockRestore(); }
  });
});
