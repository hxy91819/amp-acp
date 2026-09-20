import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { AmpExecutionRequest, AmpTransport } from './amp-transport.js';

const capturedCalls: { options: Record<string, unknown> }[] = [];

mock.module('@ampcode/sdk', () => ({
  execute: ({ options }: { options: Record<string, unknown> }) => {
    capturedCalls.push({ options });
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'T-test-thread-id' };
      yield { type: 'result', subtype: 'success', is_error: false };
    })();
  },
}));

const [{ AmpAcpAgent }, { createAmpTransport }, { BUILTIN_AMP_MODES }] = await Promise.all([
  import('./server.js'),
  import('./amp-transport.js'),
  import('./amp-modes.js'),
]);

const syntheticPluginMode = {
  key: 'synthetic-specialist',
  label: 'Synthetic Specialist',
  description: 'Uses a synthetic plugin agent for specialized work.',
};
const testModeCatalog = async () => [...BUILTIN_AMP_MODES, syntheticPluginMode];

const mockClient = {
  sessionUpdate: async () => {},
  readTextFile: async () => ({ text: '' }),
  writeTextFile: async () => ({}),
  requestPermission: async () => ({ optionId: '' }),
  createTerminal: async () => ({ id: '' }),
  extMethod: async () => ({}),
  extNotification: async () => {},
} as unknown as AgentSideConnection;

describe('AmpAcpAgent prompt() continue option', () => {
  let agent: InstanceType<typeof AmpAcpAgent>;
  const originalEnv = process.env.AMP_ACP_CONTINUE_LATEST;

  beforeEach(async () => {
    capturedCalls.length = 0;
    delete process.env.AMP_ACP_CONTINUE_LATEST;
    agent = new AmpAcpAgent(mockClient, createAmpTransport('sdk'), { modeCatalog: testModeCatalog });
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AMP_ACP_CONTINUE_LATEST;
    } else {
      process.env.AMP_ACP_CONTINUE_LATEST = originalEnv;
    }
  });

  it('does not set continue on first prompt when env var is unset (default)', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.continue).toBeUndefined();
    expect(capturedCalls[0]!.options.mode).toBe('medium');
  });

  it('passes selected Amp mode to the SDK', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'amp-mode', value: 'ultra' });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.mode).toBe('ultra');
  });

  it('passes a selected plugin mode key to the SDK instead of its display label', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: 'Synthetic Specialist',
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.mode).toBe('synthetic-specialist');
  });

  it('locks Amp mode after the first prompt starts', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    await expect(agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: 'synthetic-specialist',
    })).rejects.toThrow('Amp mode is fixed after the first prompt');
  });

  it('passes low mode to the SDK', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'amp-mode', value: 'low' });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.mode).toBe('low');
  });

  it('rejects config changes after the Amp process has started', async () => {
    const transport: AmpTransport = {
      name: 'cli',
      async *execute() {
        yield { type: 'system', subtype: 'init', session_id: 'T-started-thread' };
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    agent = new AmpAcpAgent(mockClient, transport);
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    await expect(agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'amp-mode',
      value: 'high',
    })).rejects.toThrow('Session configuration cannot change after the Amp process has started');
  });

  it('rejects config changes after cancellation before Amp reports its thread ID', async () => {
    const transport: AmpTransport = {
      name: 'cli',
      async *execute(request) {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('Amp CLI prompt was cancelled');
      },
    };
    agent = new AmpAcpAgent(mockClient, transport);
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const prompt = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    while (!agent.sessions.get(session.sessionId)?.active) await Promise.resolve();
    await agent.cancel({ sessionId: session.sessionId });
    expect((await prompt).stopReason).toBe('cancelled');

    await expect(agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'permission',
      value: 'bypass',
    })).rejects.toThrow('Session configuration cannot change after the Amp process has started');
  });

  it('passes selected permission config to the SDK', async () => {
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'permission', value: 'bypass' });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.dangerouslyAllowAll).toBe(true);
  });

  it('sets continue=true on first prompt when AMP_ACP_CONTINUE_LATEST is set', async () => {
    process.env.AMP_ACP_CONTINUE_LATEST = '1';
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.continue).toBe(true);
  });

  it('passes captured threadId on subsequent prompts regardless of env var', async () => {
    process.env.AMP_ACP_CONTINUE_LATEST = '1';
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    });

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0]!.options.continue).toBe(true);
    expect(capturedCalls[1]!.options.continue).toBe('T-test-thread-id');
  });

  it('marks the prompt after cancellation as a steer into the active Amp thread', async () => {
    const requests: AmpExecutionRequest[] = [];
    const transport: AmpTransport = {
      name: 'cli',
      async *execute(request) {
        requests.push(request);
        yield { type: 'system', subtype: 'init', session_id: 'T-active-thread' };
        if (requests.length === 1) {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) {
              resolve();
              return;
            }
            request.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('Amp CLI process was aborted');
        }
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    };
    agent = new AmpAcpAgent(mockClient, transport);
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const firstPrompt = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });

    while (agent.sessions.get(session.sessionId)?.threadId !== 'T-active-thread') {
      await Promise.resolve();
    }
    await agent.cancel({ sessionId: session.sessionId });
    expect((await firstPrompt).stopReason).toBe('cancelled');

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'change direction' }],
    });
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'later follow-up' }],
    });

    expect(requests.map(({ options, steer }) => ({ continue: options.continue, steer }))).toEqual([
      { continue: undefined, steer: false },
      { continue: 'T-active-thread', steer: true },
      { continue: 'T-active-thread', steer: false },
    ]);
  });
});
