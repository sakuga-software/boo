import { GitHubError, type GitHubApi } from './github.js';
import type { Session, SessionStore } from './sessions.js';

/** The session cannot read GitHub any more: its token was revoked, or its refresh failed. */
export class SessionExpired extends Error {}

// A token that stops to work within this time gets a refresh first.
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Knows the repositories that each session can read. Each read of the repositories costs the user
 * some requests of the hourly limit of GitHub, so the list stays for `ttlMs`. A webhook that changes
 * the access makes every list stale at once.
 *
 * If GitHub fails to give the list again, a delivery keeps the old list for at most twice `ttlMs`.
 * After that time the session gets no change until a read works: a repository that left the
 * installation during the failure must not keep its changes in the stream.
 */
export class Access {
  private readonly lists = new Map<string, { repos: Set<string>; readAt: number; fresh: boolean }>();
  private readonly reads = new Map<string, Promise<Set<string>>>();

  constructor(
    private readonly store: SessionStore,
    private readonly gitHub: GitHubApi,
    private readonly ttlMs = 30 * 60_000,
    private readonly now = Date.now,
  ) {}

  /** The access token of the session, refreshed first if it stops to work soon. */
  async token(session: Session): Promise<string> {
    const { tokens } = session;
    if (tokens.expiresAt === undefined || tokens.expiresAt - REFRESH_MARGIN_MS > this.now()) return tokens.accessToken;
    if (!tokens.refreshToken) return this.expire(session);
    try {
      const fresh = await this.gitHub.refresh(tokens.refreshToken);
      // GitHub rotates the refresh token: only the new tokens work now. A failed write keeps them in
      // memory, so the session works until a restart.
      await this.store.update(session.id, fresh).catch((error: unknown) => console.error(error));
      return fresh.accessToken;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) return this.expire(session);
      throw error;
    }
  }

  /** The repositories of the session, in lower case. Reads GitHub if the kept list is stale. */
  repos(session: Session): Promise<Set<string>> {
    const kept = this.lists.get(session.id);
    if (kept?.fresh && this.now() - kept.readAt < this.ttlMs) return Promise.resolve(kept.repos);
    const running = this.reads.get(session.id);
    if (running) return running;
    const read = this.read(session).finally(() => this.reads.delete(session.id));
    this.reads.set(session.id, read);
    return read;
  }

  /** The kept list of the session, if it is younger than twice `ttlMs`. A delivery reads it with no wait. */
  kept(sessionId: string): Set<string> | undefined {
    const list = this.lists.get(sessionId);
    return list && this.now() - list.readAt < 2 * this.ttlMs ? list.repos : undefined;
  }

  invalidateAll(): void {
    for (const list of this.lists.values()) list.fresh = false;
  }

  forget(sessionId: string): void {
    this.lists.delete(sessionId);
  }

  /** Calls GitHub with the token of the session. A token that GitHub refuses ends the session. */
  async withToken<T>(session: Session, call: (token: string) => Promise<T>): Promise<T> {
    const token = await this.token(session);
    try {
      return await call(token);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) return this.expire(session);
      throw error;
    }
  }

  private async read(session: Session): Promise<Set<string>> {
    const names = await this.withToken(session, (token) => this.gitHub.repositories(token));
    const repos = new Set(names.map((name) => name.toLowerCase()));
    this.lists.set(session.id, { repos, readAt: this.now(), fresh: true });
    return repos;
  }

  private async expire(session: Session): Promise<never> {
    this.forget(session.id);
    await this.store.delete(session.id);
    throw new SessionExpired(`The GitHub authorization of ${session.user.login} expired: run boo setup-webhooks again`);
  }
}
