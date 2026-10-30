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
 */
export class Access {
  private readonly lists = new Map<string, { repos: Set<string>; at: number }>();
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
      await this.store.update(session.id, fresh);
      return fresh.accessToken;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) return this.expire(session);
      throw error;
    }
  }

  /** The repositories of the session, in lower case. Reads GitHub if the kept list is stale. */
  repos(session: Session): Promise<Set<string>> {
    const kept = this.lists.get(session.id);
    if (kept && this.now() - kept.at < this.ttlMs) return Promise.resolve(kept.repos);
    const running = this.reads.get(session.id);
    if (running) return running;
    const read = this.read(session).finally(() => this.reads.delete(session.id));
    this.reads.set(session.id, read);
    return read;
  }

  /** The kept list of the session, stale or not. A delivery reads it with no wait. */
  kept(sessionId: string): Set<string> | undefined {
    return this.lists.get(sessionId)?.repos;
  }

  invalidateAll(): void {
    for (const list of this.lists.values()) list.at = -Infinity;
  }

  forget(sessionId: string): void {
    this.lists.delete(sessionId);
  }

  private async read(session: Session): Promise<Set<string>> {
    const token = await this.token(session);
    let names: string[];
    try {
      names = await this.gitHub.repositories(token);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) return this.expire(session);
      throw error;
    }
    const repos = new Set(names.map((name) => name.toLowerCase()));
    this.lists.set(session.id, { repos, at: this.now() });
    return repos;
  }

  private async expire(session: Session): Promise<never> {
    this.forget(session.id);
    await this.store.delete(session.id);
    throw new SessionExpired(`The GitHub authorization of ${session.user.login} expired: run boo setup-webhooks again`);
  }
}
