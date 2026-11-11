/** The user access tokens of the App that GitHub gives at the end of the device flow. */
export interface Tokens {
  accessToken: string;
  /** Absent if the App does not expire its user tokens. */
  refreshToken?: string;
  /** The time that the access token stops to work, in milliseconds since the epoch. */
  expiresAt?: number;
}

export interface GitHubUser {
  id: number;
  login: string;
}

export interface Installation {
  id: number;
  account: string;
  /** The installation accepted the write permissions that a merge needs: Contents and Pull requests. */
  canMerge: boolean;
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** The head of a pull request: its branch, and the repository of the branch. */
export interface PullHead {
  ref: string;
  /** `owner/name`. A pull request from a fork has the fork here. Null if the fork was deleted. */
  repo: string | null;
  sha: string;
  state: string;
}

/** The calls of the relay to GitHub. The tests give a fake. */
export interface GitHubApi {
  /** Returns the user of the token if the token belongs to the App, else undefined. */
  checkToken(accessToken: string): Promise<GitHubUser | undefined>;
  refresh(refreshToken: string): Promise<Tokens>;
  /** The installations of the App that the user of the token can read. */
  installations(accessToken: string): Promise<Installation[]>;
  /** The full names of the repositories that the user of the token reads through the App. */
  repositories(accessToken: string): Promise<string[]>;
  /** The head of a pull request, read with the token of the user. */
  pullHead(accessToken: string, repo: string, number: number): Promise<PullHead>;
  /**
   * Merges a pull request with the token of the user: GitHub records the user as the author of the
   * merge. GitHub refuses the merge if the head is not `sha`. Gives the commit of the merge.
   */
  merge(
    accessToken: string,
    repo: string,
    number: number,
    merge: { method: MergeMethod; sha: string },
  ): Promise<string>;
  deleteBranch(accessToken: string, repo: string, branch: string): Promise<void>;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The `message` of the answer of GitHub, if it gave one. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

export function gitHubApi(
  app: AppCredentials,
  fetchFn: typeof fetch = fetch,
  now = Date.now,
  apiUrl = 'https://api.github.com',
): GitHubApi {
  const request = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetchFn(url, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'boo-relay',
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined;
      const detail = typeof body?.message === 'string' ? body.message : undefined;
      throw new GitHubError(`GitHub answered ${response.status} to ${url}`, response.status, detail);
    }
    // A 204 has no body.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
  const asUser = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  const repoPath = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');

  async function* pages<T>(url: string, token: string, key: string): AsyncGenerator<T> {
    for (let page = 1; ; page++) {
      const body = await request<Record<string, unknown>>(
        `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        asUser(token),
      );
      const items = (body[key] ?? []) as T[];
      yield* items;
      if (items.length < 100) return;
    }
  }

  const installations = async (token: string): Promise<Installation[]> => {
    const found: Installation[] = [];
    for await (const item of pages<{ id: number; account: { login: string }; permissions?: Record<string, string> }>(
      `${apiUrl}/user/installations`,
      token,
      'installations',
    ))
      found.push({
        id: item.id,
        account: item.account.login,
        canMerge: item.permissions?.contents === 'write' && item.permissions.pull_requests === 'write',
      });
    return found;
  };

  return {
    async checkToken(accessToken) {
      // This endpoint takes the credentials of the App: a token of another App or of a person gives 404.
      const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64');
      try {
        const body = await request<{ user: GitHubUser }>(`${apiUrl}/applications/${app.clientId}/token`, {
          method: 'POST',
          headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
          body: JSON.stringify({ access_token: accessToken }),
        });
        return { id: body.user.id, login: body.user.login };
      } catch (error) {
        if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) return undefined;
        throw error;
      }
    },

    async refresh(refreshToken) {
      const body = await request<{
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      }>('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      // GitHub answers 200 with an `error` field if the refresh token is not valid.
      if (!body.access_token) throw new GitHubError(`GitHub refused the refresh: ${body.error ?? 'no token'}`, 401);
      return {
        accessToken: body.access_token,
        ...(body.refresh_token && { refreshToken: body.refresh_token }),
        ...(body.expires_in && { expiresAt: now() + body.expires_in * 1000 }),
      };
    },

    installations,

    async repositories(accessToken) {
      const names: string[] = [];
      for (const installation of await installations(accessToken))
        for await (const repo of pages<{ full_name: string }>(
          `${apiUrl}/user/installations/${installation.id}/repositories`,
          accessToken,
          'repositories',
        ))
          names.push(repo.full_name);
      return names;
    },

    async pullHead(accessToken, repo, number) {
      const pull = await request<{
        state: string;
        head: { ref: string; sha: string; repo: { full_name: string } | null };
      }>(`${apiUrl}/repos/${repoPath(repo)}/pulls/${number}`, asUser(accessToken));
      return { ref: pull.head.ref, sha: pull.head.sha, repo: pull.head.repo?.full_name ?? null, state: pull.state };
    },

    async merge(accessToken, repo, number, { method, sha }) {
      const body = await request<{ sha: string }>(`${apiUrl}/repos/${repoPath(repo)}/pulls/${number}/merge`, {
        method: 'PUT',
        headers: { ...asUser(accessToken).headers, 'content-type': 'application/json' },
        body: JSON.stringify({ merge_method: method, sha }),
      });
      return body.sha;
    },

    async deleteBranch(accessToken, repo, branch) {
      const ref = branch.split('/').map(encodeURIComponent).join('/');
      await request<undefined>(`${apiUrl}/repos/${repoPath(repo)}/git/refs/heads/${ref}`, {
        ...asUser(accessToken),
        method: 'DELETE',
      });
    },
  };
}
