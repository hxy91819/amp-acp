import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_AMP_MODES,
  createAmpModeCatalog,
  parsePluginAgentModeMetadata,
} from './amp-modes.js';

const syntheticMode = {
  key: 'synthetic-specialist',
  label: 'Synthetic Specialist',
  description: 'Custom agent mode from an Amp plugin.',
};
const staticMetadata = '// @amp-agent-mode {"key":"synthetic-specialist","label":"Synthetic Specialist"}\n';

describe('parsePluginAgentModeMetadata', () => {
  it('extracts a plugin mode key and label without evaluating plugin code', () => {
    expect(parsePluginAgentModeMetadata(staticMetadata)).toEqual({
      modes: [syntheticMode],
      diagnostics: [],
    });
  });

  it('reports malformed metadata without inventing a mode or model ID', () => {
    expect(parsePluginAgentModeMetadata('// @amp-agent-mode {"key":42}\n')).toMatchObject({
      modes: [],
      diagnostics: ['Ignored malformed @amp-agent-mode metadata.'],
    });
  });
});

describe('createAmpModeCatalog', () => {
  let fixtureDir = '';
  let projectWithPlugin = '';
  let projectWithoutPlugin = '';
  let sideEffectMarker = '';

  beforeAll(async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'amp-mode-catalog-test-'));
    projectWithPlugin = path.join(fixtureDir, 'with-plugin');
    projectWithoutPlugin = path.join(fixtureDir, 'without-plugin');
    sideEffectMarker = path.join(projectWithPlugin, 'plugin-was-executed');
    await mkdir(path.join(projectWithPlugin, '.amp', 'plugins'), { recursive: true });
    await mkdir(projectWithoutPlugin, { recursive: true });
    await writeFile(
      path.join(projectWithPlugin, '.amp', 'plugins', 'synthetic.ts'),
      `${staticMetadata}writeFileSync(${JSON.stringify(sideEffectMarker)}, 'executed');\n`,
    );
  });

  afterAll(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it('discovers static plugin metadata per working directory and preserves the built-in modes', async () => {
    const catalog = createAmpModeCatalog({
      systemPluginDirectory: path.join(fixtureDir, 'no-system-plugin'),
      globalPluginCacheDirectory: path.join(fixtureDir, 'no-global-plugin'),
    });

    const withPlugin = await catalog(projectWithPlugin);
    const withoutPlugin = await catalog(projectWithoutPlugin);
    await catalog(projectWithPlugin);

    expect(withPlugin).toEqual({ modes: [...BUILTIN_AMP_MODES, syntheticMode] });
    expect(withoutPlugin).toEqual({ modes: BUILTIN_AMP_MODES });
    await expect(stat(sideEffectMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads only plugin entry files and lets a project plugin shadow the same-named system plugin', async () => {
    const project = path.join(fixtureDir, 'entry-precedence-project');
    const systemPluginDirectory = path.join(fixtureDir, 'entry-precedence-system');
    await mkdir(path.join(project, '.amp', 'plugins', 'shared-plugin', 'fixtures'), { recursive: true });
    await mkdir(systemPluginDirectory, { recursive: true });
    await writeFile(
      path.join(project, '.amp', 'plugins', 'shared-plugin', 'index.ts'),
      '// @amp-agent-mode {"key":"project-mode","label":"Project Mode"}\n',
    );
    await writeFile(
      path.join(project, '.amp', 'plugins', 'shared-plugin', 'fixtures', 'not-imported.ts'),
      '// @amp-agent-mode {"key":"fixture-ghost","label":"Fixture Ghost"}\n',
    );
    await writeFile(
      path.join(systemPluginDirectory, 'shared-plugin.ts'),
      '// @amp-agent-mode {"key":"shadowed-mode","label":"Shadowed Mode"}\n',
    );
    const catalog = createAmpModeCatalog({
      systemPluginDirectory,
      globalPluginCacheDirectory: path.join(fixtureDir, 'no-global-plugin'),
      trustPluginDiscovery: false,
    });

    expect((await catalog(project)).modes.map((mode) => mode.key)).toEqual([
      'low',
      'medium',
      'high',
      'ultra',
      'project-mode',
    ]);
  });

  it('uses only the newest explicitly configured cached workspace plugin revision', async () => {
    const globalPluginCacheDirectory = path.join(fixtureDir, 'global-plugins');
    const stalePlugin = path.join(globalPluginCacheDirectory, 'ampcode.com', 'workspace', 'example@abcdef12');
    const currentPlugin = path.join(globalPluginCacheDirectory, 'ampcode.com', 'workspace', 'example@fedcba98');
    await mkdir(stalePlugin, { recursive: true });
    await mkdir(currentPlugin, { recursive: true });
    await writeFile(
      path.join(stalePlugin, 'index.ts'),
      '// @amp-agent-mode {"key":"stale-specialist","label":"Stale Specialist"}\n',
    );
    await writeFile(
      path.join(currentPlugin, 'index.ts'),
      '// @amp-agent-mode {"key":"workspace-specialist","label":"Workspace Specialist"}\n',
    );
    await utimes(stalePlugin, new Date(1_000), new Date(1_000));
    await utimes(currentPlugin, new Date(2_000), new Date(2_000));
    const catalog = createAmpModeCatalog({
      globalPluginCacheDirectory,
      systemPluginDirectory: path.join(fixtureDir, 'no-system-plugin'),
    });

    expect((await catalog(projectWithoutPlugin)).modes).toContainEqual({
      key: 'workspace-specialist',
      label: 'Workspace Specialist',
      description: 'Custom agent mode from an Amp plugin.',
    });
    expect((await catalog(projectWithoutPlugin)).modes.map((mode) => mode.key)).not.toContain('stale-specialist');
  });

  it('does not load plugins through the CLI unless trusted discovery is explicitly enabled', async () => {
    let calls = 0;
    const catalog = createAmpModeCatalog({
      systemPluginDirectory: path.join(fixtureDir, 'no-system-plugin'),
      globalPluginCacheDirectory: path.join(fixtureDir, 'no-global-plugin'),
      listPluginsOutput: async () => {
        calls += 1;
        return '  agent mode: dynamic-only\n';
      },
    });

    expect((await catalog(projectWithPlugin)).modes).toEqual([...BUILTIN_AMP_MODES, syntheticMode]);
    expect(calls).toBe(0);
  });

  it('adds trusted runtime-only mode keys and retries a failed trusted discovery', async () => {
    let attempts = 0;
    const catalog = createAmpModeCatalog({
      trustPluginDiscovery: true,
      systemPluginDirectory: path.join(fixtureDir, 'no-system-plugin'),
      globalPluginCacheDirectory: path.join(fixtureDir, 'no-global-plugin'),
      listPluginsOutput: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary plugin host failure');
        return '  agent mode: dynamic-only\n';
      },
    });

    const failed = await catalog(projectWithoutPlugin);
    expect(failed).toMatchObject({
      modes: BUILTIN_AMP_MODES,
      diagnostic: 'Trusted Amp plugin discovery failed: temporary plugin host failure',
    });

    expect(await catalog(projectWithoutPlugin)).toEqual({
      modes: [
        ...BUILTIN_AMP_MODES,
        {
          key: 'dynamic-only',
          label: 'dynamic-only',
          description: 'Custom agent mode from an Amp plugin. Its label is unavailable from the CLI.',
        },
      ],
    });
    expect(attempts).toBe(2);
  });
});
