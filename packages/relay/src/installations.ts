import { createSign } from 'node:crypto';
import { GitHubError } from './github.js';

/** The App identity that reads the pull requests (D2): its id and its private key, in PEM. */
export interface AppKey {
  appId: string;
  privateKey: string;
}

/** Reads GitHub with the installation tokens of the App: no user is needed, and no user quota is used. */
export interface InstallationReader {
  /** The installations of the App, by account login in lower case. */
  installations(): Promise<Map<string, number>>;
  /** A token of the installation on `owner`, or undefined if the App is not installed there. */
  tokenFor(owner: string): Promise<string | undefined>;
}

// GitHub refuses a JWT that lives more than 10 minutes, and a clock a little ahead of it.
const JWT_LIFE_S = 9 * 60;
const CLOCK_SKEW_S = 60;
// An installation token lives one hour. It is taken again when less than this time remains.
const TOKEN_MARGIN_MS = 5 * 60_000;
// An installation that is added appears in the list after this time at most.
const LIST_TTL_MS = 10 * 60_000;

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** The JSON Web Token that authenticates the App itself, signed with RS256. */
export function appJwt({ appId, privateKey }: AppKey, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - CLOCK_SKEW_S, exp: now + JWT_LIFE_S, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/**
 * Keeps one token for each installation, and the list of the installations. Two calls at the same
 * time for one installation share one request.
 */
export function installationReader(
  key: AppKey,
  { fetch: fetchFn = fetch, apiUrl = 'https://api.github.com', now = Date.now } = {},
): InstallationReader {
  const tokens = new Map<number, Promise<{ token: string; expiresAt: number }>>();
  let list: { at: number; ids: Promise<Map<string, number>> } | undefined;

  const asApp = async <T>(path: string, method = 'GET'): Promise<T> => {
    const response = await fetchFn(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'boo-relay',
        authorization: `Bearer ${appJwt(key, now())}`,
      },
    });
    if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} to ${path}`, response.status);
    return (await response.json()) as T;
  };

  async function readList(): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    for (let page = 1; ; page++) {
      const items = await asApp<{ id: number; account: { login: string } | null }[]>(
        `/app/installations?per_page=100&page=${page}`,
      );
      for (const item of items) if (item.account) ids.set(item.account.login.toLowerCase(), item.id);
      if (items.length < 100) return ids;
    }
  }

  function installations(): Promise<Map<string, number>> {
    if (!list || now() - list.at >= LIST_TTL_MS) {
      const ids = readList();
      list = { at: now(), ids };
      // A failed read is not kept: the next call reads again.
      ids.catch(() => {
        if (list?.ids === ids) list = undefined;
      });
    }
    return list.ids;
  }

  async function tokenFor(owner: string): Promise<string | undefined> {
    const id = (await installations()).get(owner.toLowerCase());
    if (id === undefined) return undefined;
    const kept = tokens.get(id);
    if (kept) {
      const value = await kept.catch(() => undefined);
      if (value && value.expiresAt - TOKEN_MARGIN_MS > now()) return value.token;
      if (tokens.get(id) !== kept) return tokenFor(owner);
    }
    const fresh = asApp<{ token: string; expires_at: string }>(`/app/installations/${id}/access_tokens`, 'POST').then(
      (body) => ({ token: body.token, expiresAt: Date.parse(body.expires_at) }),
    );
    tokens.set(id, fresh);
    fresh.catch(() => {
      if (tokens.get(id) === fresh) tokens.delete(id);
    });
    return (await fresh).token;
  }

  return { installations, tokenFor };
}
