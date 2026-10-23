import { homedir } from 'node:os';
import path from 'node:path';

export function defaultAmpAcpStateDir(): string {
  if (process.env.AMP_ACP_STATE_DIR) return process.env.AMP_ACP_STATE_DIR;
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'amp-acp');
}
