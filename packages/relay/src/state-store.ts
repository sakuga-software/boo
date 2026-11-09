import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PullRequest, PullRequestSnapshot } from '@sakuga-software/boo-core/github';
import type { Settings } from '@sakuga-software/boo-core/settings';

/** What a user follows: the settings of boo, and the organization of the list ('' for every account). */
export interface WatchConfig {
  org: string;
  settings: Settings;
}

/** The last read of a pull request. `snapshot` is undefined if no read worked yet. */
export interface StoredPull {
  pr: PullRequest;
  snapshot?: PullRequestSnapshot;
  error?: string;
  readAt: number;
}

/** D9: the text of a pull request stays on the disk this long after it closes, or after nobody follows it. */
export const KEEP_AFTER_CLOSE_MS = 7 * 24 * 60 * 60_000;

const keyOf = (pr: Pick<PullRequest, 'repo' | 'number'>) => `${pr.repo.toLowerCase()}#${pr.number}`;

/**
 * Keeps the watch config of each user and the last read of each pull request in SQLite (D7), so that
 * they survive a restart. A pull request is stored once, whatever the count of users that follow it.
 */
export class StateStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS configs (
        login TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pulls (
        key TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        pr TEXT NOT NULL,
        head TEXT,
        snapshot TEXT,
        error TEXT,
        read_at INTEGER NOT NULL,
        closed_at INTEGER,
        unfollowed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS pulls_by_head ON pulls (repo, head);
      CREATE TABLE IF NOT EXISTS follows (
        login TEXT NOT NULL,
        key TEXT NOT NULL,
        PRIMARY KEY (login, key)
      );
      CREATE INDEX IF NOT EXISTS follows_by_key ON follows (key);
    `);
  }

  close(): void {
    this.db.close();
  }

  config(login: string): WatchConfig | undefined {
    const row = this.db.prepare('SELECT config FROM configs WHERE login = ?').get(login.toLowerCase()) as
      | { config: string }
      | undefined;
    return row ? (JSON.parse(row.config) as WatchConfig) : undefined;
  }

  /** D6: the last write wins. */
  setConfig(login: string, config: WatchConfig, now: number): void {
    this.db
      .prepare(
        'INSERT INTO configs (login, config, updated_at) VALUES (?, ?, ?) ON CONFLICT (login) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at',
      )
      .run(login.toLowerCase(), JSON.stringify(config), now);
  }

  /** The logins that have a watch config. */
  logins(): string[] {
    return (this.db.prepare('SELECT login FROM configs ORDER BY login').all() as { login: string }[]).map(
      (row) => row.login,
    );
  }

  pull(pr: Pick<PullRequest, 'repo' | 'number'>): StoredPull | undefined {
    const row = this.db.prepare('SELECT pr, snapshot, error, read_at FROM pulls WHERE key = ?').get(keyOf(pr)) as
      | { pr: string; snapshot: string | null; error: string | null; read_at: number }
      | undefined;
    return row && toStored(row);
  }

  /** Records a read. A failed read keeps the last snapshot that worked, with the error. */
  savePull(pr: PullRequest, read: { snapshot: PullRequestSnapshot } | { error: string }, now: number): void {
    const key = keyOf(pr);
    if ('error' in read) {
      this.db
        .prepare(
          `INSERT INTO pulls (key, repo, number, pr, error, read_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET error = excluded.error, read_at = excluded.read_at`,
        )
        .run(key, pr.repo.toLowerCase(), pr.number, JSON.stringify(pr), read.error, now);
      return;
    }
    const { snapshot } = read;
    const open = snapshot.status === 'open' || snapshot.status === 'draft';
    this.db
      .prepare(
        `INSERT INTO pulls (key, repo, number, pr, head, snapshot, error, read_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT (key) DO UPDATE SET pr = excluded.pr, head = excluded.head, snapshot = excluded.snapshot,
           error = NULL, read_at = excluded.read_at,
           closed_at = CASE WHEN excluded.closed_at IS NULL THEN NULL ELSE COALESCE(pulls.closed_at, excluded.closed_at) END`,
      )
      .run(
        key,
        pr.repo.toLowerCase(),
        pr.number,
        JSON.stringify({ ...pr, title: pr.title || snapshot.title || '' }),
        snapshot.head,
        JSON.stringify(snapshot),
        now,
        open ? null : now,
      );
  }

  /** The pull requests of `repo` whose head commit is `sha`: a `status` webhook names only the commit. */
  pullsWithHead(repo: string, sha: string): PullRequest[] {
    return (
      this.db.prepare('SELECT pr FROM pulls WHERE repo = ? AND head = ?').all(repo.toLowerCase(), sha) as {
        pr: string;
      }[]
    ).map((row) => JSON.parse(row.pr) as PullRequest);
  }

  /** The logins that follow the pull request. */
  followers(pr: Pick<PullRequest, 'repo' | 'number'>): string[] {
    return (
      this.db.prepare('SELECT login FROM follows WHERE key = ? ORDER BY login').all(keyOf(pr)) as { login: string }[]
    ).map((row) => row.login);
  }

  /** True if at least one user follows the pull request. */
  followed(pr: Pick<PullRequest, 'repo' | 'number'>): boolean {
    return this.db.prepare('SELECT 1 FROM follows WHERE key = ? LIMIT 1').get(keyOf(pr)) !== undefined;
  }

  /**
   * Replaces the list of the pull requests that `login` follows. A pull request that nobody follows
   * any more keeps its row, so that its last state can still be read, until `purge` deletes it.
   */
  setFollows(login: string, prs: readonly Pick<PullRequest, 'repo' | 'number'>[], now: number): void {
    const user = login.toLowerCase();
    const keys = new Set(prs.map(keyOf));
    const before = (this.db.prepare('SELECT key FROM follows WHERE login = ?').all(user) as { key: string }[]).map(
      (row) => row.key,
    );
    this.db.exec('BEGIN');
    try {
      const remove = this.db.prepare('DELETE FROM follows WHERE login = ? AND key = ?');
      for (const key of before) if (!keys.has(key)) remove.run(user, key);
      const add = this.db.prepare('INSERT OR IGNORE INTO follows (login, key) VALUES (?, ?)');
      for (const key of keys) add.run(user, key);
      this.db
        .prepare(
          `UPDATE pulls SET unfollowed_at = CASE
             WHEN EXISTS (SELECT 1 FROM follows WHERE follows.key = pulls.key) THEN NULL
             ELSE COALESCE(unfollowed_at, ?) END`,
        )
        .run(now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * The last read of each pull request that `login` follows. With `readable`, the repositories in
   * lower case that the user reads through the App, only the pull requests of these repositories.
   */
  pullsOf(login: string, readable?: ReadonlySet<string>): StoredPull[] {
    return (
      this.db
        .prepare(
          'SELECT pr, snapshot, error, read_at FROM pulls JOIN follows ON follows.key = pulls.key WHERE follows.login = ? ORDER BY pulls.key',
        )
        .all(login.toLowerCase()) as { pr: string; snapshot: string | null; error: string | null; read_at: number }[]
    )
      .map(toStored)
      .filter((stored) => !readable || readable.has(stored.pr.repo.toLowerCase()));
  }

  /**
   * D9: deletes the pull requests closed, or followed by nobody, for more than KEEP_AFTER_CLOSE_MS,
   * with their text. Returns the count of pull requests deleted.
   */
  purge(now: number): number {
    const limit = now - KEEP_AFTER_CLOSE_MS;
    this.db.exec('BEGIN');
    try {
      const old = (
        this.db.prepare('SELECT key FROM pulls WHERE closed_at <= ? OR unfollowed_at <= ?').all(limit, limit) as {
          key: string;
        }[]
      ).map((row) => row.key);
      const removeFollows = this.db.prepare('DELETE FROM follows WHERE key = ?');
      const removePull = this.db.prepare('DELETE FROM pulls WHERE key = ?');
      for (const key of old) {
        removeFollows.run(key);
        removePull.run(key);
      }
      this.db.exec('COMMIT');
      return old.length;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function toStored(row: { pr: string; snapshot: string | null; error: string | null; read_at: number }): StoredPull {
  return {
    pr: JSON.parse(row.pr) as PullRequest,
    ...(row.snapshot && { snapshot: JSON.parse(row.snapshot) as PullRequestSnapshot }),
    ...(row.error && { error: row.error }),
    readAt: row.read_at,
  };
}
