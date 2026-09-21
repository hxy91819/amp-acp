import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
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

/** Built-in Amp modes are always part of the discovered catalog before optional filtering. */
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

interface PluginEntry {
  identity: string;
  entryFile: string;
}

function isPluginSourceFile(filePath: string): boolean {
  return PLUGIN_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function pluginIdentityFromFile(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).toLowerCase();
}

function pluginIdentityFromDirectory(directory: string): string {
  return path.basename(directory).toLowerCase();
}

async function findPluginEntries(target: string, directoryIsPluginRoot = false): Promise<PluginEntry[]> {
  let targetStats: Awaited<ReturnType<typeof stat>>;
  try {
    targetStats = await stat(target);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  if (targetStats.isFile()) {
    return isPluginSourceFile(target) ? [{ identity: pluginIdentityFromFile(target), entryFile: target }] : [];
  }
  if (!targetStats.isDirectory()) return [];

  if (directoryIsPluginRoot) {
    for (const entryName of ['index.ts', 'index.js']) {
      const entryFile = path.join(target, entryName);
      try {
        if ((await stat(entryFile)).isFile()) {
          return [{ identity: pluginIdentityFromDirectory(target), entryFile }];
        }
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
  }

  const plugins: PluginEntry[] = [];
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isFile() && isPluginSourceFile(entry.name)) {
      plugins.push({ identity: pluginIdentityFromFile(entry.name), entryFile: entryPath });
      continue;
    }
    if (!entry.isDirectory()) continue;

    const typescriptEntry = path.join(entryPath, 'index.ts');
    const javascriptEntry = path.join(entryPath, 'index.js');
    try {
      const entryStats = await stat(typescriptEntry);
      if (entryStats.isFile()) {
        plugins.push({ identity: pluginIdentityFromDirectory(entryPath), entryFile: typescriptEntry });
        continue;
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    try {
      const entryStats = await stat(javascriptEntry);
      if (entryStats.isFile()) {
        plugins.push({ identity: pluginIdentityFromDirectory(entryPath), entryFile: javascriptEntry });
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  return plugins;
}

const CACHE_REVISION_DIRECTORY = /^(.+)@([0-9a-f]{8,})$/i;

async function findCachedPluginEntries(cacheDirectory: string): Promise<PluginEntry[]> {
  const candidates = new Map<string, { entry: PluginEntry; modifiedAt: number }>();

  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryDirectory = path.join(directory, entry.name);
      const cacheMatch = CACHE_REVISION_DIRECTORY.exec(entry.name);
      if (!cacheMatch?.[1]) {
        await visit(entryDirectory);
        continue;
      }
      const typescriptEntry = path.join(entryDirectory, 'index.ts');
      const javascriptEntry = path.join(entryDirectory, 'index.js');
      let entryFile: string | undefined;
      try {
        if ((await stat(typescriptEntry)).isFile()) entryFile = typescriptEntry;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      if (!entryFile) {
        try {
          if ((await stat(javascriptEntry)).isFile()) entryFile = javascriptEntry;
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
      }
      if (!entryFile) continue;
      const identity = `${directory}\0${cacheMatch[1].toLowerCase()}`;
      const modifiedAt = (await stat(entryDirectory)).mtimeMs;
      const previous = candidates.get(identity);
      if (!previous || previous.modifiedAt < modifiedAt) {
        candidates.set(identity, {
          entry: { identity: cacheMatch[1].toLowerCase(), entryFile },
          modifiedAt,
        });
      }
    }
  };

  await visit(cacheDirectory);
  return [...candidates.values()].map((candidate) => candidate.entry);
}

function mergePluginModes(pluginModes: readonly AmpModeOption[], diagnostics: string[]): AmpModeOption[] {
  const modes = [...BUILTIN_AMP_MODES];
  const seenKeys = new Set(modes.map((mode) => mode.key.toLowerCase()));
  const seenLabels = new Set(modes.map((mode) => mode.label.toLowerCase()));
  for (const mode of pluginModes) {
    const keyIdentity = mode.key.toLowerCase();
    const labelIdentity = mode.label.toLowerCase();
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

/**
 * Selects an ordered subset of discovered modes by their stable keys. The
 * configuration deliberately cannot invent a mode: each key must have been
 * verified through the ordinary discovery path for this session.
 */
function selectVisibleModes(
  discoveredModes: readonly AmpModeOption[],
  visibleModeKeys: readonly string[] | undefined,
  diagnostics: string[],
): AmpModeOption[] {
  if (visibleModeKeys === undefined) return [...discoveredModes];

  const byKey = new Map(discoveredModes.map((mode) => [mode.key.toLowerCase(), mode]));
  const selected: AmpModeOption[] = [];
  const seen = new Set<string>();
  for (const configuredKey of visibleModeKeys) {
    const key = configuredKey.trim();
    if (!key) continue;
    const identity = key.toLowerCase();
    if (seen.has(identity)) {
      diagnostics.push(`Ignored duplicate configured Amp mode ${key}.`);
      continue;
    }
    seen.add(identity);
    const discovered = byKey.get(identity);
    if (!discovered) {
      diagnostics.push(`Configured Amp mode ${key} was not discovered for this session and is hidden.`);
      continue;
    }
    selected.push(discovered);
  }
  if (selected.length === 0 && visibleModeKeys.every((key) => !key.trim())) {
    diagnostics.push('Configured Amp mode list does not contain any mode keys.');
  }
  return selected;
}

async function readStaticPluginModes(entries: readonly PluginEntry[]): Promise<ParsedMetadata> {
  const modes: AmpModeOption[] = [];
  const diagnostics: string[] = [];
  for (const entry of entries) {
    const parsed = parsePluginAgentModeMetadata(await readFile(entry.entryFile, 'utf8'));
    modes.push(...parsed.modes);
    diagnostics.push(...parsed.diagnostics.map((diagnostic) => `${diagnostic} Source: ${entry.entryFile}`));
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
  /** Overrides the default system plugin directory; mainly for tests. */
  systemPluginDirectory?: string;
  /** Additional Personal Plugin locations, processed above Workspace plugins. */
  personalPluginDirectories?: readonly string[];
  /** Additional Workspace Plugin locations, processed below Personal plugins. */
  workspacePluginDirectories?: readonly string[];
  /** An explicitly trusted cache root whose newest cached entry per plugin is treated as Workspace metadata. */
  globalPluginCacheDirectory?: string;
  /** Ordered stable mode keys to expose; defaults to the AMP_ACP_MODE_KEYS environment variable when set. */
  visibleModeKeys?: readonly string[];
  /** Opt into the CLI command that loads plugins; defaults to AMP_ACP_TRUST_PLUGIN_DISCOVERY=1. */
  trustPluginDiscovery?: boolean;
  /** Overrides trusted CLI discovery for tests. */
  listPluginsOutput?: (cwd: string) => Promise<string>;
}

function configuredDirectories(variable: string): string[] {
  return process.env[variable]
    ?.split(path.delimiter)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    ?? [];
}

function configuredModeKeys(): string[] | undefined {
  const configured = process.env.AMP_ACP_MODE_KEYS;
  return configured === undefined ? undefined : configured.split(',');
}

async function selectEffectivePluginEntries(cwd: string, options: AmpModeCatalogOptions): Promise<PluginEntry[]> {
  const systemPluginDirectory = options.systemPluginDirectory
    ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'amp', 'plugins');
  const selected = new Map<string, PluginEntry>();
  const addEntries = (entries: readonly PluginEntry[]) => {
    for (const entry of entries) selected.set(entry.identity, entry);
  };

  // Later sources replace the entire same-named plugin, matching Amp's
  // workspace < personal < system < project precedence.
  const configuredCache = options.globalPluginCacheDirectory ?? process.env.AMP_ACP_GLOBAL_PLUGIN_CACHE_DIR;
  if (configuredCache) addEntries(await findCachedPluginEntries(configuredCache));
  for (const directory of [
    ...configuredDirectories('AMP_ACP_WORKSPACE_PLUGIN_PATHS'),
    ...(options.workspacePluginDirectories ?? []),
  ]) addEntries(await findPluginEntries(directory, true));
  for (const directory of [
    ...configuredDirectories('AMP_ACP_PERSONAL_PLUGIN_PATHS'),
    ...(options.personalPluginDirectories ?? []),
  ]) addEntries(await findPluginEntries(directory, true));
  addEntries(await findPluginEntries(systemPluginDirectory));
  addEntries(await findPluginEntries(path.join(cwd, '.amp', 'plugins')));
  return [...selected.values()];
}

/**
 * Builds a mode catalog from Amp's documented static metadata. Project and
 * system plugin files are read without evaluating their code. Sources are
 * selected by Amp's project > system > personal > workspace precedence before
 * metadata is read. Personal/workspace locations and an optional cache root
 * must be explicitly configured because cache contents alone do not prove a
 * plugin is currently enabled for this Amp account or workspace.
 */
export function createAmpModeCatalog(options: AmpModeCatalogOptions = {}): AmpModeCatalog {
  const command = options.command ?? process.env.AMP_CLI_PATH ?? 'amp';
  const commandArgs = options.commandArgs ?? [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const trustPluginDiscovery = options.trustPluginDiscovery ?? process.env.AMP_ACP_TRUST_PLUGIN_DISCOVERY === '1';
  const visibleModeKeys = options.visibleModeKeys ?? configuredModeKeys();
  const cache = new Map<string, { expiresAt: number; promise: Promise<AmpModeCatalogResult> }>();

  const discover = async (cwd: string): Promise<AmpModeCatalogResult> => {
    const diagnostics: string[] = [];
    let staticModes: ParsedMetadata;
    try {
      staticModes = await readStaticPluginModes(await selectEffectivePluginEntries(cwd, options));
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

    const modes = selectVisibleModes(mergePluginModes(pluginModes, diagnostics), visibleModeKeys, diagnostics);
    return diagnostics.length > 0 ? { modes, diagnostic: diagnostics.join(' ') } : { modes };
  };

  return (cwd) => {
    const cached = cache.get(cwd);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    let discovery: Promise<AmpModeCatalogResult>;
    discovery = discover(cwd).catch((error: unknown) => {
      const detail = errorMessage(error);
      console.error(`[acp] unexpected Amp mode discovery failure for ${cwd}:`, error);
      const diagnostics = [`Amp mode discovery failed: ${detail}`];
      return {
        modes: selectVisibleModes(BUILTIN_AMP_MODES, visibleModeKeys, diagnostics),
        diagnostic: diagnostics.join(' '),
      };
    });
    cache.set(cwd, { expiresAt: Date.now() + cacheTtlMs, promise: discovery });
    void discovery.then((result) => {
      if (result.diagnostic && cache.get(cwd)?.promise === discovery) cache.delete(cwd);
    });
    return discovery;
  };
}
