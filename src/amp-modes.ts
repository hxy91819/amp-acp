import { spawn } from 'node:child_process';

/** A selectable Amp mode. `key` is the execution value; `label` is UI-only. */
export interface AmpModeOption {
  key: string;
  label: string;
  description: string;
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
export type AmpModeCatalog = (cwd: string) => Promise<readonly AmpModeOption[]>;

const PLUGIN_MODE_LINE = /^\s*agent mode:\s*(\S+)\s*$/i;

/** Extracts stable plugin mode keys from the supported `amp plugins list` output. */
export function parsePluginAgentModeKeys(output: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const match = PLUGIN_MODE_LINE.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const identity = key.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    keys.push(key);
  }
  return keys;
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
  /** Kill a stalled discovery command after this duration. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Cache successful discovery per working directory for this duration. Defaults to 60 seconds. */
  cacheTtlMs?: number;
  /** Overrides CLI discovery for tests. */
  listPluginsOutput?: (cwd: string) => Promise<string>;
}

function withPluginModes(keys: readonly string[]): AmpModeOption[] {
  const modes = [...BUILTIN_AMP_MODES];
  const seen = new Set(modes.map((mode) => mode.key.toLowerCase()));
  for (const key of keys) {
    const identity = key.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    // `amp plugins list` publishes a stable key but no label, description, or
    // pinned-model metadata. Do not infer any of those from the mode key.
    modes.push({
      key,
      label: key,
      description: 'Custom agent mode from an Amp plugin.',
    });
  }
  return modes;
}

/**
 * Builds a per-project catalog from the official `amp plugins list` command.
 * Plugin registration is project, user, and workspace dependent, so successful
 * discoveries are cached per cwd. Failures are logged and deliberately not
 * cached; the current session exposes only built-ins and a later session retries.
 */
export function createAmpModeCatalog(options: AmpModeCatalogOptions = {}): AmpModeCatalog {
  const command = options.command ?? process.env.AMP_CLI_PATH ?? 'amp';
  const commandArgs = options.commandArgs ?? [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const cache = new Map<string, { expiresAt: number; promise: Promise<readonly AmpModeOption[]> }>();

  const discover = async (cwd: string): Promise<readonly AmpModeOption[]> => {
    const output = options.listPluginsOutput
      ? await options.listPluginsOutput(cwd)
      : await runAmpPluginsList(command, commandArgs, cwd, timeoutMs);
    return withPluginModes(parsePluginAgentModeKeys(output));
  };

  return (cwd) => {
    const cached = cache.get(cwd);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    let discovery: Promise<readonly AmpModeOption[]>;
    discovery = discover(cwd).catch((error: unknown) => {
      if (cache.get(cwd)?.promise === discovery) cache.delete(cwd);
      console.error(
        `[acp] failed to discover Amp plugin modes for ${cwd}; offering built-in modes only:`,
        error,
      );
      return BUILTIN_AMP_MODES;
    });
    cache.set(cwd, { expiresAt: Date.now() + cacheTtlMs, promise: discovery });
    return discovery;
  };
}
