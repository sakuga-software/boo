import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeRelaySession,
  connectRelay,
  type ConnectDeps,
  type RelayConnection,
} from '@sakuga-software/boo-core/relay';

// The part of this module that runs anywhere is in core. Each name is listed: a name that the CLI
// also declared would hide the one of core with no error.
export { DEFAULT_RELAY, relayUrl, SetupError, type RelayConnection } from '@sakuga-software/boo-core/relay';

export const relayPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'boo', 'relay.json');
export async function loadRelay(path = relayPath()): Promise<RelayConnection | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<RelayConnection>;
    return value.url && value.session && value.login
      ? { url: value.url, session: value.session, login: value.login }
      : undefined;
  } catch {
    return undefined;
  }
}

async function saveRelay(connection: RelayConnection, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  // A file that existed before keeps its mode through writeFile: set it again.
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export interface SetupDeps extends ConnectDeps {
  path: string;
}

/**
 * Connects this machine to a relay (see `connectRelay`), then saves the relay URL and the session
 * token, readable only by the owner of the file.
 */
export async function setupWebhooks(input: string | undefined, setup: SetupDeps): Promise<RelayConnection> {
  const connection = await connectRelay(input, setup);
  await saveRelay(connection, setup.path);
  return connection;
}

/** Deletes the session on the relay, then the file. A relay that does not answer leaves no file either. */
export async function removeWebhooks(
  remove: Pick<SetupDeps, 'fetch' | 'log' | 'path' | 'timeoutMs'>,
): Promise<boolean> {
  const connection = await loadRelay(remove.path);
  if (!connection) return false;
  await closeRelaySession(connection, remove);
  await rm(remove.path, { force: true });
  return true;
}
