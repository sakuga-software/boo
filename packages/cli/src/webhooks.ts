import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The relay that Sakuga hosts. `boo setup-webhooks <url>` takes another one. */
export const DEFAULT_RELAY = 'https://boo-relay.sakuga.dev';

/** The connection of this machine to a relay. The file holds a session token: only its owner reads it. */
export interface RelayConnection {
  url: string;
  session: string;
  login: string;
}

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

export interface SetupDeps {
  fetch: typeof fetch;
  open: (url: string) => Promise<void>;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  path: string;
}

export class SetupError extends Error {}

const json = async <T>(response: Response, what: string): Promise<T> => {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new SetupError(`${what}: ${response.status}${body.error ? ` ${body.error}` : ''}`);
  }
  return (await response.json().catch(() => {
    throw new SetupError(`${what}: the answer is not JSON`);
  })) as T;
};

/** Normalizes the URL that a person types: no trailing slash, and https when the scheme is missing. */
export function relayUrl(input: string | undefined): string {
  const url = (input ?? DEFAULT_RELAY).trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceToken {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  interval?: number;
}

/** Gets a user token of the App with the device flow: the person types a code on github.com. */
async function deviceFlow(
  clientId: string,
  deps: SetupDeps,
): Promise<Required<Pick<DeviceToken, 'access_token'>> & DeviceToken> {
  const form = (fields: Record<string, string>) => ({
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const code = await json<DeviceCode>(
    await deps.fetch('https://github.com/login/device/code', form({ client_id: clientId })),
    'GitHub refused the device code',
  );
  deps.log(`Open ${code.verification_uri} and type the code ${code.user_code}`);
  await deps.open(code.verification_uri).catch(() => {});
  const end = deps.now() + code.expires_in * 1000;
  let interval = code.interval * 1000;
  while (deps.now() < end) {
    await deps.sleep(interval);
    const token = await json<DeviceToken>(
      await deps.fetch(
        'https://github.com/login/oauth/access_token',
        form({
          client_id: clientId,
          device_code: code.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      ),
      'GitHub refused the token',
    );
    if (token.access_token) return { ...token, access_token: token.access_token };
    if (token.error === 'authorization_pending') continue;
    // GitHub asks for a longer wait, and gives the new interval.
    if (token.error === 'slow_down') interval = (token.interval ?? interval / 1000 + 5) * 1000;
    else if (token.error === 'access_denied') throw new SetupError('The authorization was denied on GitHub.');
    else if (token.error === 'expired_token') break;
    else throw new SetupError(`GitHub refused the token: ${token.error ?? 'no token'}`);
  }
  throw new SetupError('The code expired before the authorization. Run boo setup-webhooks again.');
}

interface Installations {
  installations: { id: number; account: string }[];
  installUrl: string;
}

// The time that the setup waits for an installation of the App.
const INSTALL_WAIT_MS = 10 * 60_000;
const INSTALL_POLL_MS = 5_000;

/**
 * Connects this machine to a relay:
 * 1. Gets a user token of the App of the relay with the device flow.
 * 2. Opens a session on the relay. Only the session token stays on this machine.
 * 3. If the user reads no installation of the App, opens the install page and waits for one.
 * 4. Saves the relay URL and the session token, readable only by the owner of the file.
 */
export async function setupWebhooks(input: string | undefined, deps: SetupDeps): Promise<RelayConnection> {
  const url = relayUrl(input);
  const relay = await json<{ name?: string; clientId?: string; installUrl?: string }>(
    await deps.fetch(url).catch((error: unknown) => {
      throw new SetupError(`No relay answers at ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }),
    `The relay at ${url} refused the request`,
  ).catch((error: unknown) => {
    // A page that is not JSON is a web site, not a relay.
    if (error instanceof SetupError && error.message.endsWith('not JSON'))
      throw new SetupError(`${url} is not a boo relay.`);
    throw error;
  });
  if (relay.name !== 'boo-relay' || !relay.clientId) throw new SetupError(`${url} is not a boo relay.`);
  deps.log(`Relay: ${url}`);

  const token = await deviceFlow(relay.clientId, deps);
  const { session, login } = await json<{ session: string; login: string }>(
    await deps.fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accessToken: token.access_token,
        ...(token.refresh_token && { refreshToken: token.refresh_token }),
        ...(token.expires_in && { expiresIn: token.expires_in }),
      }),
    }),
    'The relay refused the session',
  );
  deps.log(`Signed in as ${login}`);

  const auth = { headers: { authorization: `Bearer ${session}` } };
  const installations = () =>
    deps
      .fetch(`${url}/installations`, auth)
      .then((response) => json<Installations>(response, 'The relay refused the installations'));
  let found = await installations();
  if (found.installations.length === 0) {
    deps.log(`Install the App on your organizations or your account: ${found.installUrl}`);
    deps.log('An owner of an organization installs it; a member can only request it.');
    await deps.open(found.installUrl).catch(() => {});
    const end = deps.now() + INSTALL_WAIT_MS;
    while (found.installations.length === 0 && deps.now() < end) {
      await deps.sleep(INSTALL_POLL_MS);
      found = await installations();
    }
    if (found.installations.length === 0)
      deps.log('No installation yet. The setup is saved: the watch gets changes after the App is installed.');
  }
  for (const installation of found.installations) deps.log(`Installed on ${installation.account}`);

  const connection = { url, session, login };
  await saveRelay(connection, deps.path);
  return connection;
}

/** Deletes the session on the relay, then the file. A relay that does not answer leaves no file either. */
export async function removeWebhooks(deps: Pick<SetupDeps, 'fetch' | 'log' | 'path'>): Promise<boolean> {
  const connection = await loadRelay(deps.path);
  if (!connection) return false;
  await deps
    .fetch(`${connection.url}/sessions`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${connection.session}` },
    })
    .catch(() => deps.log(`The relay at ${connection.url} did not answer: the session stays there until it expires.`));
  await rm(deps.path, { force: true });
  return true;
}
