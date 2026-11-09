/** The relay that Sakuga hosts. `boo setup-webhooks <url>` takes another one. */
export const DEFAULT_RELAY = 'https://boo-relay.sakuga.dev';

/** The connection of this machine to a relay. The file holds a session token: only its owner reads it. */
export interface RelayConnection {
  url: string;
  session: string;
  login: string;
}

/** What the setup needs from its host: the CLI gives the ones of Node, the mobile app the ones of Expo. */
export interface ConnectDeps {
  fetch: typeof fetch;
  open: (url: string) => Promise<void>;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The longest wait for one answer of the network. */
  timeoutMs?: number;
}

const TIMEOUT_MS = 15_000;

/** Gives up a call that gets no answer in time: a relay that accepts the connection and stays quiet must not block the command. */
function timed(fetchFn: typeof fetch, ms: number): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    try {
      // A redirect could send the GitHub token to a URL that the HTTPS check did not see.
      return await fetchFn(input, {
        redirect: 'error',
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new SetupError(`${String(input)} did not answer in ${ms / 1000} s`);
      throw error;
    }
  }) as typeof fetch;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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
  deps: ConnectDeps,
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
    if (token.error === 'slow_down') interval = Math.max(token.interval ?? 0, interval / 1000 + 5) * 1000;
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
 * Connects a client to a relay:
 * 1. Gets a user token of the App of the relay with the device flow.
 * 2. Opens a session on the relay. Only the session token stays on the client.
 * 3. If the user reads no installation of the App, opens the install page and waits for one.
 * The caller keeps the connection that it returns.
 */
export async function connectRelay(input: string | undefined, setup: ConnectDeps): Promise<RelayConnection> {
  const deps = { ...setup, fetch: timed(setup.fetch, setup.timeoutMs ?? TIMEOUT_MS) };
  const url = relayUrl(input);
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    throw new SetupError(`${url} is not a URL.`);
  }
  // The GitHub token of the user goes to the relay: in clear text, anyone on the way reads it.
  if (address.protocol === 'http:' && !LOCAL_HOSTS.has(address.hostname))
    throw new SetupError(`${url} is not HTTPS: the GitHub authorization would travel in clear text. Use https://.`);
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
  if (url !== DEFAULT_RELAY)
    deps.log(
      'Your GitHub authorization goes to this relay, which reads your pull requests: use only a relay that you trust.',
    );

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

  return { url, session, login };
}

/** Deletes the session on the relay. A relay that refuses or does not answer gets a line in the log, not an error. */
export async function closeRelaySession(
  connection: RelayConnection,
  close: Pick<ConnectDeps, 'fetch' | 'log' | 'timeoutMs'>,
): Promise<void> {
  const deps = { ...close, fetch: timed(close.fetch, close.timeoutMs ?? TIMEOUT_MS) };
  const stays = `the session stays on the relay at ${connection.url} until it expires.`;
  await deps
    .fetch(`${connection.url}/sessions`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${connection.session}` },
    })
    .then((response) => {
      // 401: the relay no longer knows the session, so nothing stays there.
      if (!response.ok && response.status !== 401)
        deps.log(`The relay refused the removal (${response.status}): ${stays}`);
    })
    .catch(() => deps.log(`The relay did not answer: ${stays}`));
}
