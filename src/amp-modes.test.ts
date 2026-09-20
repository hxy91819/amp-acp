import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_AMP_MODES,
  createAmpModeCatalog,
  parsePluginAgentModeKeys,
} from './amp-modes.js';

describe('parsePluginAgentModeKeys', () => {
  it('extracts only agent-mode keys from the official plugin-list output', () => {
    const output = [
      '✓ sample-plugin (.amp/plugins/sample.ts) active',
      '  agent: synthetic-specialist-agent',
      '  agent mode: synthetic-specialist',
      '  tool: sample-tool',
      '  agent mode: synthetic-specialist',
      '  agent modes: not-a-mode',
      '  agent mode:',
    ].join('\n');

    expect(parsePluginAgentModeKeys(output)).toEqual(['synthetic-specialist']);
  });
});

describe('createAmpModeCatalog', () => {
  it('discovers plugin mode keys per working directory and preserves the built-in modes', async () => {
    const calls: string[] = [];
    const catalog = createAmpModeCatalog({
      listPluginsOutput: async (cwd) => {
        calls.push(cwd);
        return cwd === '/workspace/with-plugin'
          ? '  agent mode: synthetic-specialist\n'
          : '';
      },
    });

    const withPlugin = await catalog('/workspace/with-plugin');
    const withoutPlugin = await catalog('/workspace/without-plugin');
    await catalog('/workspace/with-plugin');

    expect(withPlugin).toEqual([
      ...BUILTIN_AMP_MODES,
      {
        key: 'synthetic-specialist',
        label: 'synthetic-specialist',
        description: 'Custom agent mode from an Amp plugin.',
      },
    ]);
    expect(withoutPlugin).toEqual(BUILTIN_AMP_MODES);
    expect(calls).toEqual(['/workspace/with-plugin', '/workspace/without-plugin']);
  });

  it('does not cache a failed discovery, so a later session can discover a recovered plugin', async () => {
    let attempts = 0;
    const catalog = createAmpModeCatalog({
      listPluginsOutput: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary plugin host failure');
        return '  agent mode: synthetic-specialist\n';
      },
    });

    expect(await catalog('/workspace/retry')).toEqual(BUILTIN_AMP_MODES);
    expect((await catalog('/workspace/retry')).map((mode) => mode.key)).toContain('synthetic-specialist');
    expect(attempts).toBe(2);
  });
});
