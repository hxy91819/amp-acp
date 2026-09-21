import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAmpArchiveArgs,
  buildAmpCliArgs,
  buildAmpSdkOptions,
  createAmpTransport,
  createCliTransport,
  isAmpThreadId,
  setAmpThreadArchived,
  type AmpExecutionOptions,
  type AmpStreamMessage,
  type AmpTransport,
} from './amp-transport.js';

const baseOptions: AmpExecutionOptions = {
  cwd: '/tmp/project',
  env: { TERM: 'dumb' },
  mode: 'medium',
};

let fixtureDir: string;
let fixturePath: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'amp-transport-test-'));
  fixturePath = path.join(fixtureDir, 'fake-amp.mjs');
  await writeFile(fixturePath, `
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 25));
let initialized = false;
let repeatPending = false;
const repeatMarker = ${JSON.stringify(path.join(fixtureDir, 'repeat-seen'))};
createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  const prompt = input.message.content.map((part) => part.text).join('');
  if (prompt === 'fail') {
    console.error('fixture failure');
    process.exit(2);
  }
  if (!initialized) {
    initialized = true;
    const init = () => console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'T-cli-test', process_id: process.pid }));
    if (prompt === 'early wait') {
      setTimeout(init, 5);
      return;
    }
    init();
  }
  if (prompt === 'repeat' && !input.steer && !existsSync(repeatMarker)) {
    writeFileSync(repeatMarker, 'seen');
    repeatPending = true;
    setTimeout(() => {
      console.log(JSON.stringify({ type: 'user', message: { content: input.message.content } }));
      console.log(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'stale repeated output' }], stop_reason: 'end_turn' },
      }));
      repeatPending = false;
    }, 30);
    return;
  }
  if (prompt === 'repeat' && input.steer && repeatPending) {
    setTimeout(() => {
      console.log(JSON.stringify({ type: 'user', message: { content: input.message.content } }));
      console.log(JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: prompt }], stop_reason: 'end_turn' },
        result: { prompt, steer: input.steer, processId: process.pid },
      }));
    }, 40);
    return;
  }
  console.log(JSON.stringify({ type: 'user', message: { content: input.message.content } }));
  if (prompt === 'malformed') {
    process.stdout.write('not-json\\n');
    return;
  }
  if (prompt === 'wait' && !input.steer) {
    setTimeout(() => console.log(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'stale output' }], stop_reason: 'end_turn' },
    })), 5);
    return;
  }
  if (prompt === 'pause') {
    console.log(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [], stop_reason: 'pause_turn' },
    }));
  }
  console.log(JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: 'nested-tool',
    message: {
      content: [{ type: 'text', text: 'nested response' }],
      stop_reason: 'end_turn',
    },
  }));
  console.log(JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'text', text: prompt }],
      stop_reason: prompt === 'stop sequence' ? 'stop_sequence' : 'end_turn',
    },
    result: { prompt, steer: input.steer, processId: process.pid },
  }));
});
`);
});

const transports: AmpTransport[] = [];

function fixtureTransport(preserveCancelledProcess = true): AmpTransport {
  const transport = createCliTransport(process.execPath, [fixturePath], preserveCancelledProcess);
  transports.push(transport);
  return transport;
}

afterEach(() => {
  for (const transport of transports.splice(0)) transport.closeAll?.();
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function collect(stream: AsyncIterable<AmpStreamMessage>): Promise<AmpStreamMessage[]> {
  const messages: AmpStreamMessage[] = [];
  for await (const message of stream) messages.push(message);
  return messages;
}

describe('Amp transport', () => {
  it('accepts only durable Amp thread IDs', () => {
    expect(isAmpThreadId('T-01a03c00-e608-7007-8181-5c1cc56757be')).toBe(true);
    expect(isAmpThreadId('S-01a03c00-e608-7007-8181-5c1cc56757be')).toBe(false);
    expect(isAmpThreadId('T-test-thread')).toBe(false);
    expect(isAmpThreadId('T-01a03c00-e608-7007-8181-5c1cc56757be; rm -rf /')).toBe(false);
  });

  it('builds exact archive and unarchive arguments', () => {
    const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

    expect(buildAmpArchiveArgs(threadId, true)).toEqual(['threads', 'archive', threadId]);
    expect(buildAmpArchiveArgs(threadId, false)).toEqual(['threads', 'archive', '--unarchive', threadId]);
    expect(() => buildAmpArchiveArgs('S-not-an-amp-thread', true)).toThrow('Invalid Amp thread ID');
  });

  it('archives and unarchives by invoking the configured Amp CLI directly', async () => {
    const argsPath = path.join(fixtureDir, 'archive-args.json');
    const lifecycleFixture = path.join(fixtureDir, 'fake-archive.mjs');
    const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';
    await writeFile(lifecycleFixture, `
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(2)));
`);

    await setAmpThreadArchived(threadId, true, {
      command: process.execPath,
      commandArgs: [lifecycleFixture],
      env: { ARGS_PATH: argsPath },
    });
    expect(JSON.parse(await Bun.file(argsPath).text())).toEqual([
      'threads',
      'archive',
      threadId,
    ]);

    await setAmpThreadArchived(threadId, false, {
      command: process.execPath,
      commandArgs: [lifecycleFixture],
      env: { ARGS_PATH: argsPath },
    });
    expect(JSON.parse(await Bun.file(argsPath).text())).toEqual([
      'threads',
      'archive',
      '--unarchive',
      threadId,
    ]);
  });

  it('surfaces Amp CLI archive failures', async () => {
    const lifecycleFixture = path.join(fixtureDir, 'failing-archive.mjs');
    await writeFile(lifecycleFixture, `
console.error('archive fixture failure');
process.exit(3);
`);

    await expect(setAmpThreadArchived(
      'T-01a03c00-e608-7007-8181-5c1cc56757be',
      true,
      { command: process.execPath, commandArgs: [lifecycleFixture] },
    )).rejects.toThrow('Amp CLI process exited with code 3: archive fixture failure');
  });

  it('uses the CLI transport by default', () => {
    const originalTransport = process.env.AMP_ACP_TRANSPORT;
    delete process.env.AMP_ACP_TRANSPORT;
    try {
      expect(createAmpTransport().name).toBe('cli');
    } finally {
      if (originalTransport === undefined) {
        delete process.env.AMP_ACP_TRANSPORT;
      } else {
        process.env.AMP_ACP_TRANSPORT = originalTransport;
      }
    }
  });

  it('selects both supported transports', () => {
    expect(createAmpTransport('sdk').name).toBe('sdk');
    expect(createAmpTransport('cli').name).toBe('cli');
    expect(() => createAmpTransport('other')).toThrow('Unsupported AMP_ACP_TRANSPORT: other');
  });

  it('builds arguments for a new CLI thread', () => {
    expect(buildAmpCliArgs(baseOptions)).toEqual([
      '--execute',
      '--stream-json',
      '--stream-json-input',
      '--no-archive-after-execute',
      '--mode',
      'medium',
    ]);
  });

  it('passes current modes through to the SDK', () => {
    for (const mode of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(buildAmpSdkOptions({ ...baseOptions, mode })).toMatchObject({
        mode,
        noArchiveAfterExecute: true,
      });
    }
  });

  it('passes Orb execution options through to the SDK', () => {
    expect(buildAmpSdkOptions({
      ...baseOptions,
      executor: 'orb',
      project: 'acme/widgets',
    })).toMatchObject({
      executor: 'orb',
      project: 'acme/widgets',
    });
  });

  it('builds arguments for continuing a specific CLI thread', () => {
    expect(buildAmpCliArgs({
      ...baseOptions,
      continue: 'T-test-thread',
      dangerouslyAllowAll: true,
      mcpConfig: { exa: { url: 'https://mcp.exa.ai/mcp' } },
    })).toEqual([
      'threads',
      'continue',
      'T-test-thread',
      '--execute',
      '--stream-json',
      '--stream-json-input',
      '--no-archive-after-execute',
      '--mode',
      'medium',
      '--dangerously-allow-all',
      '--mcp-config',
      '{"exa":{"url":"https://mcp.exa.ai/mcp"}}',
    ]);
  });

  it('continues the latest CLI thread when requested', () => {
    expect(buildAmpCliArgs({ ...baseOptions, continue: true }).slice(0, 4)).toEqual([
      'threads',
      'continue',
      '--last',
      '--execute',
    ]);
  });

  it('streams JSON messages from the CLI process', async () => {
    const controller = new AbortController();
    const transport = fixtureTransport();

    const messages = await collect(transport.execute({
      sessionId: 'session-stream',
      prompt: 'hello from ACP',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: controller.signal,
      steer: false,
    }));

    expect(messages).toEqual([
      expect.objectContaining({ type: 'system', subtype: 'init', session_id: 'T-cli-test' }),
      expect.objectContaining({ type: 'user' }),
      expect.objectContaining({ type: 'assistant', parent_tool_use_id: 'nested-tool' }),
      expect.objectContaining({
        type: 'assistant',
        parent_tool_use_id: null,
        result: expect.objectContaining({ prompt: 'hello from ACP', steer: false }),
      }),
    ]);
  });

  it('continues streaming after an intermediate pause_turn', async () => {
    const transport = fixtureTransport();

    const messages = await collect(transport.execute({
      sessionId: 'session-pause',
      prompt: 'pause',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: new AbortController().signal,
      steer: false,
    }));

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'assistant',
      message: expect.objectContaining({ stop_reason: 'pause_turn' }),
    }));
    expect(messages.at(-1)).toMatchObject({
      type: 'assistant',
      result: { prompt: 'pause' },
    });
  });

  it('finishes on other terminal stop reasons', async () => {
    const transport = fixtureTransport();

    const messages = await collect(transport.execute({
      sessionId: 'session-stop-sequence',
      prompt: 'stop sequence',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: new AbortController().signal,
      steer: false,
    }));

    expect(messages.at(-1)).toMatchObject({
      type: 'assistant',
      message: { stop_reason: 'stop_sequence' },
      result: { prompt: 'stop sequence' },
    });
  });

  it('includes CLI stderr when the process fails', async () => {
    const transport = fixtureTransport();

    await expect(collect(transport.execute({
      sessionId: 'session-fail',
      prompt: 'fail',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: new AbortController().signal,
      steer: false,
    }))).rejects.toThrow('Amp CLI process exited with code 2: fixture failure');
  });

  it('keeps the CLI process alive and writes steering input after cancellation', async () => {
    const controller = new AbortController();
    const transport = fixtureTransport();
    const iterator = transport.execute({
      sessionId: 'session-steer',
      prompt: 'wait',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: controller.signal,
      steer: false,
    })[Symbol.asyncIterator]();

    const initial = (await iterator.next()).value as AmpStreamMessage & { process_id: number };
    expect(initial.type).toBe('system');
    controller.abort();
    await expect(iterator.next()).rejects.toThrow('Amp CLI prompt was cancelled');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const steered = await collect(transport.execute({
      sessionId: 'session-steer',
      prompt: 'wait',
      options: { ...baseOptions, cwd: fixtureDir, continue: 'T-cli-test' },
      signal: new AbortController().signal,
      steer: true,
    }));
    expect(steered).not.toContainEqual(expect.objectContaining({
      message: expect.objectContaining({
        content: [expect.objectContaining({ text: 'stale output' })],
      }),
    }));
    expect(steered.at(-1)).toMatchObject({
      type: 'assistant',
      result: {
        prompt: 'wait',
        steer: true,
        processId: initial.process_id,
      },
    });
  });

  it('delivers delayed initialization after steering an early cancellation', async () => {
    const controller = new AbortController();
    const transport = fixtureTransport();
    const iterator = transport.execute({
      sessionId: 'session-early-steer',
      prompt: 'early wait',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: controller.signal,
      steer: false,
    })[Symbol.asyncIterator]();

    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(pending).rejects.toThrow('Amp CLI prompt was cancelled');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const steered = await collect(transport.execute({
      sessionId: 'session-early-steer',
      prompt: 'change direction',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: new AbortController().signal,
      steer: true,
    }));
    expect(steered).toContainEqual(expect.objectContaining({
      type: 'system',
      subtype: 'init',
      session_id: 'T-cli-test',
    }));
    expect(steered.at(-1)).toMatchObject({
      type: 'assistant',
      result: { prompt: 'change direction', steer: true },
    });
  });

  it('does not attribute a cancelled prompt response to a same-text replacement', async () => {
    const controller = new AbortController();
    const transport = fixtureTransport();
    const iterator = transport.execute({
      sessionId: 'session-repeat-steer',
      prompt: 'repeat',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: controller.signal,
      steer: false,
    })[Symbol.asyncIterator]();

    const initial = (await iterator.next()).value as AmpStreamMessage & { process_id: number };
    expect(initial).toMatchObject({ type: 'system', subtype: 'init' });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow('Amp CLI prompt was cancelled');

    const steered = await collect(transport.execute({
      sessionId: 'session-repeat-steer',
      prompt: 'repeat',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: new AbortController().signal,
      steer: true,
    }));
    expect(steered).not.toContainEqual(expect.objectContaining({
      message: expect.objectContaining({
        content: [expect.objectContaining({ text: 'stale repeated output' })],
      }),
    }));
    expect(steered.at(-1)).toMatchObject({
      type: 'assistant',
      result: { prompt: 'repeat', steer: false },
    });
    const replacementInit = steered.find((message) => message.type === 'system') as
      | (AmpStreamMessage & { process_id: number })
      | undefined;
    expect(replacementInit?.process_id).not.toBe(initial.process_id);
  });

  it('terminates the CLI process on standard ACP cancellation', async () => {
    const controller = new AbortController();
    const transport = fixtureTransport(false);
    const iterator = transport.execute({
      sessionId: 'session-cancel',
      prompt: 'wait',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: controller.signal,
      steer: false,
    })[Symbol.asyncIterator]();

    const initial = (await iterator.next()).value as AmpStreamMessage & { process_id: number };
    controller.abort();
    await expect(iterator.next()).rejects.toThrow('Amp CLI prompt was cancelled');
    expect(() => process.kill(initial.process_id, 0)).toThrow();

    const restarted = await collect(transport.execute({
      sessionId: 'session-cancel',
      prompt: 'after cancel',
      options: { ...baseOptions, cwd: fixtureDir, continue: 'T-cli-test' },
      signal: new AbortController().signal,
      steer: true,
    }));
    const restartedInit = restarted.find((message) => message.type === 'system') as
      | (AmpStreamMessage & { process_id: number })
      | undefined;
    expect(restartedInit).toBeDefined();
    expect(restartedInit?.process_id).not.toBe(initial.process_id);
  });

  it('terminates a session with malformed output and starts a clean process next time', async () => {
    const transport = fixtureTransport();
    await expect(collect(transport.execute({
      sessionId: 'session-malformed',
      prompt: 'malformed',
      options: { ...baseOptions, cwd: fixtureDir },
      signal: new AbortController().signal,
      steer: false,
    }))).rejects.toThrow('Failed to parse JSON response, raw line: not-json');

    const recovered = await collect(transport.execute({
      sessionId: 'session-malformed',
      prompt: 'recovered',
      options: { ...baseOptions, cwd: fixtureDir, continue: 'T-cli-test' },
      signal: new AbortController().signal,
      steer: false,
    }));
    expect(recovered).toContainEqual(expect.objectContaining({ type: 'system' }));
    expect(recovered.at(-1)).toMatchObject({
      type: 'assistant',
      result: { prompt: 'recovered' },
    });
  });
});
