import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface RemoteDialOptions {
  url?: string;
  apiKey?: string;
  dataDirectory?: string;
  command?: string;
  commandArgs?: readonly string[];
  timeoutMs?: number;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function parseDial(response: unknown): string[] {
  const modes = field(field(response, 'result'), 'dialModes');
  if (!Array.isArray(modes) || modes.length === 0) {
    throw new Error('No saved remote Amp Dial was returned. Save a Dial in Amp settings first.');
  }
  if (!modes.every((mode): mode is string => typeof mode === 'string' && mode.trim().length > 0)) {
    throw new Error('Amp returned an invalid remote Dial.');
  }
  return [...new Set(modes)];
}

/**
 * Amp CLI's internal getUserInfo response contains the effective ordered Dial.
 * Keep this dependency here so an Amp API change has one integration point.
 * Model tuning stays server-owned; callers pass these mode keys to Amp unchanged.
 */
export function createRemoteDialReader(options: RemoteDialOptions = {}): (cwd: string) => Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const dataDirectory = options.dataDirectory
    ?? path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'amp');
  const command = options.command ?? process.env.AMP_CLI_PATH ?? 'amp';
  const commandArgs = options.commandArgs ?? [];

  return async (cwd) => {
    let serviceURL: URL;
    try {
      serviceURL = new URL(options.url ?? process.env.AMP_URL ?? 'https://ampcode.com/');
      if (!['http:', 'https:'].includes(serviceURL.protocol) || serviceURL.username || serviceURL.password) {
        throw new Error('Invalid service URL');
      }
    } catch {
      throw new Error('Invalid AMP_URL for remote Dial discovery.');
    }
    const configuredKey = options.apiKey ?? process.env.AMP_API_KEY;
    const readKey = async (): Promise<string | undefined> => {
      if (configuredKey) return configuredKey;
      try {
        const stored: unknown = JSON.parse(await readFile(path.join(dataDirectory, 'secrets.json'), 'utf8'));
        const token = field(stored, `apiKey@${serviceURL.href}`);
        return typeof token === 'string' && token.length > 0 ? token : undefined;
      } catch (error) {
        if (field(error, 'code') === 'ENOENT') return undefined;
        throw new Error('Unable to read Amp login credentials. Run amp login and retry.');
      }
    };

    const request = async (token: string): Promise<{ authRequired: boolean; body?: unknown }> => {
      let response: Response;
      try {
        response = await fetch(new URL('/api/internal?getUserInfo', serviceURL), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ method: 'getUserInfo', params: {} }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch {
        // Neither server bodies nor transport errors are safe diagnostic text:
        // they can include account data, URLs, or the authorization header.
        throw new Error('Unable to fetch the remote Amp Dial. Check connectivity and Amp login.');
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return { authRequired: true };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Remote Dial request failed (HTTP ${response.status}).`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('Unable to fetch the remote Amp Dial. Amp returned an unreadable response.');
      }
      if (field(body, 'ok') !== true) {
        if (field(field(body, 'error'), 'code') === 'auth-required') return { authRequired: true };
        throw new Error('Amp rejected the remote Dial request.');
      }
      return { authRequired: false, body };
    };

    let token = await readKey();
    if (!token) throw new Error('Remote Dial requires Amp authentication. Run amp login or set AMP_API_KEY.');
    let result = await request(token);
    if (result.authRequired && !configuredKey) {
      // Let Amp own OAuth refresh and credential-file updates. `usage` performs
      // no inference and does not load project plugins. Never expose its output.
      await new Promise<void>((resolve, reject) => {
        execFile(command, [...commandArgs, 'usage'], { cwd, timeout: timeoutMs, windowsHide: true }, (error) => {
          if (error) reject(new Error('Amp login refresh failed. Run amp login and retry.'));
          else resolve();
        });
      });
      token = await readKey();
      if (!token) throw new Error('Amp login credentials are unavailable after refresh.');
      result = await request(token);
    }
    if (result.authRequired) throw new Error('Amp authentication expired or was rejected. Run amp login or update AMP_API_KEY.');
    return parseDial(result.body);
  };
}
