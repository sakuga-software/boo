import { GitHubError, type GitHubApi } from './github.js';
import type { Session, SessionStore } from './sessions.js';

/** The session cannot read GitHub any more: its token was revoked, or its refresh failed. */
export class SessionExpired extends Error {}

// A token that stops to work within this time gets a refresh first.
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Knows the repositories that each session can read. Each read of the repositories costs the user
 * some requests of the hourly limit of GitHub, so the list stays for `ttlMs`.
 *
 * A session gets no change while its list is not valid. Then the watch reads with its safety poll.
 * A list is not valid in these conditions:
 * - A webhook changed the access, and the new read is not complete. A repository that left the
 *   installation must not send one more change.
 * - GitHub failed to give the list again for twice `ttlMs`.
 */
export class Access {
  private readonly lists = new Map<string, { repos: Set<string>; readAt: number; fresh: boolean }>();
  private readonly reads = new Map<string, Promise<Set<string>>>();
  private readonly refreshes = new Map<string, Promise<string>>();
  /** Counts the access webhooks. A read that started before the last one gives old data. */
  private generation = 0;

  constructor(
    private readonly store: SessionStore,
    private readonly gitHub: GitHubApi,
    private readonly ttlMs = 30 * 60_000,
    private readonly now = Date.now,
  ) {}

  /**
   * The access token of the session, refreshed first if it stops to work soon. GitHub rotates the
   * refresh token, so two refreshes of one session at the same time share one call: a second call
   * with the old refresh token fails and ends a valid session.
   */
  token(session: Session): Promise<string> {
    const { tokens } = session;
    if (tokens.expiresAt === undefined || tokens.expiresAt - REFRESH_MARGIN_MS > this.now())
      return Promise.resolve(tokens.accessToken);
    const running = this.refreshes.get(session.id);
    if (running) return running;
    const refresh = this.refresh(session).finally(() => this.refreshes.delete(session.id));
    this.refreshes.set(session.id, refresh);
    return refresh;
  }

  private async refresh(session: Session): Promise<string> {
    const { refreshToken } = session.tokens;
    if (!refreshToken) return this.expire(session);
    try {
      const fresh = await this.gitHub.refresh(refreshToken);
      // Only the new tokens work now. A failed write keeps them in memory, so the session works
      // until a restart.
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

  /** The kept list of the session, if it is valid. A delivery reads it with no wait. */
  kept(sessionId: string): Set<string> | undefined {
    const list = this.lists.get(sessionId);
    return list?.fresh && this.now() - list.readAt < 2 * this.ttlMs ? list.repos : undefined;
  }

  invalidateAll(): void {
    this.generation++;
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
    let names: string[];
    let generation: number;
    // An access webhook during the read makes its data old: read again.
    do {
      generation = this.generation;
      names = await this.withToken(session, (token) => this.gitHub.repositories(token));
    } while (generation !== this.generation);
    const repos = new Set(names.map((name) => name.toLowerCase()));
    // A session deleted during the read must not get its list back.
    if (this.store.has(session.id)) this.lists.set(session.id, { repos, readAt: this.now(), fresh: true });
    return repos;
  }

  private async expire(session: Session): Promise<never> {
    this.forget(session.id);
    await this.store.delete(session.id);
    throw new SessionExpired(`The GitHub authorization of ${session.user.login} expired: run boo setup-webhooks again`);
  }
}
