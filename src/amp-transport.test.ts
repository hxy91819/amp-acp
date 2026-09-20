import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAmpCliArgs,
  buildAmpSdkOptions,
  createAmpTransport,
  createCliTransport,
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
let initialized = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  const prompt = input.message.content.map((part) => part.text).join('');
  if (prompt === 'fail') {
    console.error('fixture failure');
    process.exit(2);
  }
  if (!initialized) {
    initialized = true;
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'T-cli-test', process_id: process.pid }));
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
      stop_reason: 'end_turn',
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

  it('passes a plugin mode key through to both execution transports', () => {
    const pluginMode = 'synthetic-specialist';
    expect(buildAmpCliArgs({ ...baseOptions, mode: pluginMode })).toContain(pluginMode);
    expect(buildAmpSdkOptions({ ...baseOptions, mode: pluginMode })).toMatchObject({ mode: pluginMode });
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
