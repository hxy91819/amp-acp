import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** A selectable Amp mode. `key` is the execution value; `label` is UI-only. */
export interface AmpModeOption {
  key: string;
  label: string;
  description: string;
}

export interface AmpModeCatalogResult {
  modes: readonly AmpModeOption[];
  /** A message suitable for an ACP config-option description when discovery is incomplete. */
  diagnostic?: string;
}

/** The four built-in Amp modes remain available regardless of installed plugins. */
export const BUILTIN_AMP_MODES: readonly AmpModeOption[] = [
  {
    key: 'low',
    label: 'Low',
    description: 'Fast and economical for simple, well-defined tasks.',
  },
  {
    key: 'medium',
    label: 'Medium',
    description: 'Balanced capability and cost for everyday coding tasks.',
  },
  {
    key: 'high',
    label: 'High',
    description: 'Greater capability and reasoning for difficult tasks.',
  },
  {
    key: 'ultra',
    label: 'Ultra',
    description: 'Maximum capability for the most demanding tasks.',
  },
];

/** Returns the modes selectable in one session working directory. */
export type AmpModeCatalog = (cwd: string) => Promise<AmpModeCatalogResult>;

interface ParsedMetadata {
  modes: AmpModeOption[];
  diagnostics: string[];
}

const AGENT_MODE_METADATA_LINE = /^\s*\/\/\s*@amp-agent-mode\s+(.+?)\s*$/gm;
const PLUGIN_MODE_LINE = /^\s*agent mode:\s*(\S+)\s*$/i;
const PLUGIN_SOURCE_EXTENSIONS = new Set(['.js', '.ts']);

function isAgentModeMetadata(value: unknown): value is { key: string; label: string } {
  if (typeof value !== 'object' || value === null) return false;
  const key = Reflect.get(value, 'key');
  const label = Reflect.get(value, 'label');
  return typeof key === 'string' && key.trim().length > 0 && typeof label === 'string' && label.trim().length > 0;
}

/**
 * Parses Amp's documented static mode directive. It reads only source text and
 * deliberately does not import or execute the plugin.
 */
export function parsePluginAgentModeMetadata(source: string): ParsedMetadata {
  const modes: AmpModeOption[] = [];
  const diagnostics: string[] = [];
  const seenKeys = new Set<string>();
  const seenLabels = new Set<string>();
  for (const match of source.matchAll(AGENT_MODE_METADATA_LINE)) {
    const serialized = match[1];
    if (!serialized) continue;
    try {
      const metadata: unknown = JSON.parse(serialized);
      if (!isAgentModeMetadata(metadata)) throw new Error('invalid metadata');
      const key = metadata.key.trim();
      const label = metadata.label.trim();
      const keyIdentity = key.toLowerCase();
      const labelIdentity = label.toLowerCase();
      if (seenKeys.has(keyIdentity) || seenLabels.has(labelIdentity)) {
        diagnostics.push(`Ignored duplicate @amp-agent-mode metadata for ${key}.`);
        continue;
      }
      seenKeys.add(keyIdentity);
      seenLabels.add(labelIdentity);
      modes.push({ key, label, description: 'Custom agent mode from an Amp plugin.' });
    } catch {
      diagnostics.push('Ignored malformed @amp-agent-mode metadata.');
    }
  }
  return { modes, diagnostics };
}

/** Extracts runtime-only mode keys from the official `amp plugins list` output. */
export function parsePluginAgentModeKeys(output: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const match = PLUGIN_MODE_LINE.exec(line);
    const key = match?.[1];
    if (!key) continue;
    const identity = key.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    keys.push(key);
  }
  return keys;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function findPluginSourceFiles(target: string): Promise<string[]> {
  let targetStats: Awaited<ReturnType<typeof stat>>;
  try {
    targetStats = await stat(target);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  if (targetStats.isFile()) {
    return PLUGIN_SOURCE_EXTENSIONS.has(path.extname(target)) ? [target] : [];
  }
  if (!targetStats.isDirectory()) return [];

  const files: string[] = [];
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findPluginSourceFiles(entryPath));
    } else if (entry.isFile() && PLUGIN_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function mergePluginModes(pluginModes: readonly AmpModeOption[], diagnostics: string[]): AmpModeOption[] {
  const modes = [...BUILTIN_AMP_MODES];
  const seenKeys = new Set(modes.map((mode) => mode.key.toLowerCase()));
  const seenLabels = new Set(modes.map((mode) => mode.label.toLowerCase()));
  for (const mode of pluginModes) {
    const keyIdentity = mode.key.toLowerCase();
    const labelIdentity = mode.label.toLowerCase();
    const sameMode = modes.find((candidate) => candidate.key.toLowerCase() === keyIdentity);
    if (sameMode?.label.toLowerCase() === labelIdentity) continue;
    if (seenKeys.has(keyIdentity) || seenLabels.has(labelIdentity)) {
      diagnostics.push(`Ignored conflicting Amp plugin mode ${mode.key}.`);
      continue;
    }
    seenKeys.add(keyIdentity);
    seenLabels.add(labelIdentity);
    modes.push(mode);
  }
  return modes;
}

async function readStaticPluginModes(metadataPaths: readonly string[]): Promise<ParsedMetadata> {
  const modes: AmpModeOption[] = [];
  const diagnostics: string[] = [];
  for (const metadataPath of metadataPaths) {
    for (const sourceFile of await findPluginSourceFiles(metadataPath)) {
      const parsed = parsePluginAgentModeMetadata(await readFile(sourceFile, 'utf8'));
      modes.push(...parsed.modes);
      diagnostics.push(...parsed.diagnostics.map((diagnostic) => `${diagnostic} Source: ${sourceFile}`));
    }
  }
  return { modes, diagnostics };
}

function runAmpPluginsList(
  command: string,
  commandArgs: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...commandArgs, 'plugins', 'list'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`\`${command} plugins list\` timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString());
        return;
      }
      const details = Buffer.concat(stderr).toString().trim();
      reject(new Error(`\`${command} plugins list\` exited with code ${code}${details ? `: ${details}` : ''}`));
    }));
  });
}

export interface AmpModeCatalogOptions {
  /** Amp CLI command; defaults to AMP_CLI_PATH or `amp`. */
  command?: string;
  commandArgs?: readonly string[];
  /** Kill trusted runtime discovery after this duration. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Cache successful discovery per working directory for this duration. Defaults to 60 seconds. */
  cacheTtlMs?: number;
  /** Extra directories or files containing trusted static plugin metadata. */
  metadataPaths?: readonly string[];
  /** Overrides the default system plugin directory; mainly for tests. */
  systemPluginDirectory?: string;
  /** Overrides the default global plugin metadata cache; mainly for tests. */
  globalPluginCacheDirectory?: string;
  /** Opt into the CLI command that loads plugins; defaults to AMP_ACP_TRUST_PLUGIN_DISCOVERY=1. */
  trustPluginDiscovery?: boolean;
  /** Overrides trusted CLI discovery for tests. */
  listPluginsOutput?: (cwd: string) => Promise<string>;
}

function metadataPathsFor(cwd: string, options: AmpModeCatalogOptions): string[] {
  const cacheHome = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache');
  const systemPluginDirectory = options.systemPluginDirectory
    ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'amp', 'plugins');
  const globalPluginCacheDirectory = options.globalPluginCacheDirectory
    ?? path.join(cacheHome, 'amp', 'global-plugins');
  const configuredPaths = process.env.AMP_ACP_MODE_METADATA_PATHS
    ?.split(path.delimiter)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    ?? [];
  return [
    path.join(cwd, '.amp', 'plugins'),
    systemPluginDirectory,
    globalPluginCacheDirectory,
    ...configuredPaths,
    ...(options.metadataPaths ?? []),
  ];
}

/**
 * Builds a mode catalog from Amp's documented static metadata. Project and
 * system plugin files, plus the Amp global-plugin metadata cache, are read
 * without evaluating their code. Callers may supply additional checked-out
 * metadata paths, or explicitly opt into `amp plugins list` when they trust
 * loading every plugin that Amp makes effective in the session cwd.
 */
export function createAmpModeCatalog(options: AmpModeCatalogOptions = {}): AmpModeCatalog {
  const command = options.command ?? process.env.AMP_CLI_PATH ?? 'amp';
  const commandArgs = options.commandArgs ?? [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const trustPluginDiscovery = options.trustPluginDiscovery ?? process.env.AMP_ACP_TRUST_PLUGIN_DISCOVERY === '1';
  const cache = new Map<string, { expiresAt: number; promise: Promise<AmpModeCatalogResult> }>();

  const discover = async (cwd: string): Promise<AmpModeCatalogResult> => {
    const diagnostics: string[] = [];
    let staticModes: ParsedMetadata;
    try {
      staticModes = await readStaticPluginModes(metadataPathsFor(cwd, options));
      diagnostics.push(...staticModes.diagnostics);
    } catch (error) {
      const detail = errorMessage(error);
      console.error(`[acp] failed to discover static Amp plugin metadata for ${cwd}:`, error);
      diagnostics.push(`Static Amp plugin metadata discovery failed: ${detail}`);
      staticModes = { modes: [], diagnostics: [] };
    }

    const pluginModes = [...staticModes.modes];
    if (trustPluginDiscovery) {
      try {
        const output = options.listPluginsOutput
          ? await options.listPluginsOutput(cwd)
          : await runAmpPluginsList(command, commandArgs, cwd, timeoutMs);
        pluginModes.push(...parsePluginAgentModeKeys(output).map((key) => ({
          key,
          label: key,
          description: 'Custom agent mode from an Amp plugin. Its label is unavailable from the CLI.',
        })));
      } catch (error) {
        const detail = errorMessage(error);
        console.error(`[acp] trusted Amp plugin discovery failed for ${cwd}:`, error);
        diagnostics.push(`Trusted Amp plugin discovery failed: ${detail}`);
      }
    }

    const modes = mergePluginModes(pluginModes, diagnostics);
    return diagnostics.length > 0 ? { modes, diagnostic: diagnostics.join(' ') } : { modes };
  };

  return (cwd) => {
    const cached = cache.get(cwd);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    let discovery: Promise<AmpModeCatalogResult>;
    discovery = discover(cwd).catch((error: unknown) => {
      const detail = errorMessage(error);
      console.error(`[acp] unexpected Amp mode discovery failure for ${cwd}:`, error);
      return { modes: BUILTIN_AMP_MODES, diagnostic: `Amp mode discovery failed: ${detail}` };
    });
    cache.set(cwd, { expiresAt: Date.now() + cacheTtlMs, promise: discovery });
    void discovery.then((result) => {
      if (result.diagnostic && cache.get(cwd)?.promise === discovery) cache.delete(cwd);
    });
    return discovery;
  };
}
