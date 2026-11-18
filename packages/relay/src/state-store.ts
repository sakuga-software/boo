import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WatchEvent } from '@sakuga-software/boo-core/events';
import type { PullRequest, PullRequestSnapshot } from '@sakuga-software/boo-core/github';
import type { PullRequestReport } from '@sakuga-software/boo-core/report';
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

/** BOO-9: the history of the pull requests stays this long after its last change, for the statistics. */
export const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** The summary of a pull request that a user follows or followed. The times are milliseconds, but `mergedAt` is the ISO time of GitHub. */
export interface HistoryPull {
  repo: string;
  number: number;
  author: string | null;
  /** The kind of the coding agent of the pull request, such as `claude-code`, or null. */
  agent: string | null;
  /** The first time the relay saw the pull request for this user. */
  firstSeenAt: number;
  /** The last state, as the report gives it. */
  state: string;
  mergedAt: string | null;
  mergedBy: string | null;
  closedAt: number | null;
  /** The count of reviews, and of checks that turned red, while the relay followed the pull request. */
  reviews: number;
  redChecks: number;
  updatedAt: number;
}

export interface HistoryEvent {
  at: number;
  event: string;
  data: Record<string, unknown>;
}

interface HistoryRow {
  repo: string;
  number: number;
  author: string | null;
  agent: string | null;
  first_seen_at: number;
  state: string;
  merged_at: string | null;
  merged_by: string | null;
  closed_at: number | null;
  reviews: number;
  red_checks: number;
  updated_at: number;
}

const toHistoryPull = (row: HistoryRow): HistoryPull => ({
  repo: row.repo,
  number: row.number,
  author: row.author,
  agent: row.agent,
  firstSeenAt: row.first_seen_at,
  state: row.state,
  mergedAt: row.merged_at,
  mergedBy: row.merged_by,
  closedAt: row.closed_at,
  reviews: row.reviews,
  redChecks: row.red_checks,
  updatedAt: row.updated_at,
});

/**
 * The fields of an event that the history keeps, or undefined for an event that it does not keep. The
 * history keeps no text written by a person (comments, review bodies), and no whole report.
 */
function historyData(event: WatchEvent): Record<string, unknown> | undefined {
  switch (event.event) {
    case 'entered':
      return { state: event.state };
    case 'state':
      return { from: event.from, to: event.to, failing: event.failing };
    case 'head':
      return { from: event.from, to: event.to };
    case 'review':
      return {
        reviewer: event.reviewer,
        mark: event.mark,
        onHead: event.onHead,
        verdict: event.verdict,
        score: event.score,
        reviewedAt: event.reviewedAt,
      };
    case 'check':
      return { check: event.check, to: event.to, ...(event.reviewerError && { reviewerError: true }) };
    case 'left':
      return { reason: event.reason, mergedBy: event.mergedBy ?? null, mergedAt: event.mergedAt ?? null };
    case 'restack':
      return { oldBase: event.oldBase, base: event.base };
    default:
      return undefined;
  }
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
      CREATE TABLE IF NOT EXISTS devices (
        token TEXT PRIMARY KEY,
        session TEXT NOT NULL,
        login TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS devices_by_login ON devices (login);
      CREATE INDEX IF NOT EXISTS devices_by_session ON devices (session);
      CREATE TABLE IF NOT EXISTS history_pulls (
        login TEXT NOT NULL,
        key TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        author TEXT,
        agent TEXT,
        first_seen_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        merged_at TEXT,
        merged_by TEXT,
        closed_at INTEGER,
        reviews INTEGER NOT NULL DEFAULT 0,
        red_checks INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (login, key)
      );
      CREATE INDEX IF NOT EXISTS history_pulls_by_update ON history_pulls (updated_at);
      CREATE TABLE IF NOT EXISTS history_events (
        login TEXT NOT NULL,
        key TEXT NOT NULL,
        at INTEGER NOT NULL,
        event TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_events_by_pull ON history_events (login, key, at);
      CREATE INDEX IF NOT EXISTS history_events_by_time ON history_events (at);
      CREATE TABLE IF NOT EXISTS push_marks (
        login TEXT NOT NULL,
        key TEXT NOT NULL,
        state TEXT NOT NULL,
        stalled INTEGER NOT NULL,
        PRIMARY KEY (login, key)
      );
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
      const removeMarks = this.db.prepare('DELETE FROM push_marks WHERE key = ?');
      const removePull = this.db.prepare('DELETE FROM pulls WHERE key = ?');
      for (const key of old) {
        removeFollows.run(key);
        removeMarks.run(key);
        removePull.run(key);
      }
      this.db.exec('COMMIT');
      return old.length;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Records the history of the pull requests of `login` (BOO-9), for the statistics: a summary row for
   * each pull request of `reports`, and a row for each event of `events`. The history has its own
   * tables, so the purge of the pull requests does not delete it: `purgeHistory` does.
   */
  recordHistory(
    login: string,
    reports: readonly PullRequestReport[],
    events: readonly WatchEvent[],
    now: number,
  ): void {
    const user = login.toLowerCase();
    const upsert = this.db.prepare(
      `INSERT INTO history_pulls (login, key, repo, number, author, agent, first_seen_at, state, merged_at, merged_by, closed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (login, key) DO UPDATE SET author = COALESCE(excluded.author, history_pulls.author),
         agent = COALESCE(excluded.agent, history_pulls.agent), state = excluded.state,
         merged_at = COALESCE(excluded.merged_at, history_pulls.merged_at),
         merged_by = COALESCE(excluded.merged_by, history_pulls.merged_by),
         closed_at = COALESCE(history_pulls.closed_at, excluded.closed_at), updated_at = excluded.updated_at`,
    );
    const touch = this.db.prepare(
      `INSERT OR IGNORE INTO history_pulls (login, key, repo, number, first_seen_at, state, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?)`,
    );
    const addEvent = this.db.prepare('INSERT INTO history_events (login, key, at, event, data) VALUES (?, ?, ?, ?, ?)');
    const countReview = this.db.prepare(
      'UPDATE history_pulls SET reviews = reviews + 1, updated_at = ? WHERE login = ? AND key = ?',
    );
    const countRedCheck = this.db.prepare(
      'UPDATE history_pulls SET red_checks = red_checks + 1, updated_at = ? WHERE login = ? AND key = ?',
    );
    this.db.exec('BEGIN');
    try {
      for (const report of reports) {
        const key = keyOf(report);
        // A report gives no author: the snapshot of the pull request does.
        const author = this.pull(report)?.snapshot?.author ?? null;
        const closed = report.state === 'closed' ? now : null;
        upsert.run(
          user,
          key,
          report.repo.toLowerCase(),
          report.number,
          author,
          report.agent.kind,
          now,
          report.state,
          report.mergedAt,
          report.mergedBy,
          closed,
          now,
        );
      }
      for (const event of events) {
        const data = historyData(event);
        if (!data) continue;
        const hash = event.pr.lastIndexOf('#');
        const pr = { repo: event.pr.slice(0, hash), number: Number(event.pr.slice(hash + 1)) };
        const key = keyOf(pr);
        touch.run(user, key, pr.repo.toLowerCase(), pr.number, now, now);
        addEvent.run(user, key, Date.parse(event.at) || now, event.event, JSON.stringify(data));
        if (event.event === 'review') countReview.run(now, user, key);
        if (event.event === 'check' && event.to === 'failing') countRedCheck.run(now, user, key);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The history of the pull requests of `login`, from the oldest seen. */
  historyOf(login: string): HistoryPull[] {
    return (
      this.db
        .prepare('SELECT * FROM history_pulls WHERE login = ? ORDER BY first_seen_at, key')
        .all(login.toLowerCase()) as unknown as HistoryRow[]
    ).map(toHistoryPull);
  }

  /** The events of one pull request of `login`, from the oldest. */
  historyEvents(login: string, pr: Pick<PullRequest, 'repo' | 'number'>): HistoryEvent[] {
    return (
      this.db
        .prepare('SELECT at, event, data FROM history_events WHERE login = ? AND key = ? ORDER BY at, rowid')
        .all(login.toLowerCase(), keyOf(pr)) as { at: number; event: string; data: string }[]
    ).map((row) => ({ at: row.at, event: row.event, data: JSON.parse(row.data) as Record<string, unknown> }));
  }

  /**
   * Deletes the events older than `retentionMs`, and the summary of each pull request with no change
   * for that time. Returns the counts of rows deleted.
   */
  purgeHistory(now: number, retentionMs = HISTORY_RETENTION_MS): { pulls: number; events: number } {
    const limit = now - retentionMs;
    const events = this.db.prepare('DELETE FROM history_events WHERE at <= ?').run(limit).changes;
    const pulls = this.db.prepare('DELETE FROM history_pulls WHERE updated_at <= ?').run(limit).changes;
    return { pulls: Number(pulls), events: Number(events) };
  }

  /**
   * Records the push token of the phone of a session. A session is one sign-in of one phone, so the
   * token replaces the token that the session had: a token that Expo rotates leaves no old row. A
   * token that another session had moves to this one: a phone that signs in again keeps one row.
   */
  setDevice(token: string, device: { session: string; login: string }, now: number): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM devices WHERE session = ? AND token <> ?').run(device.session, token);
      this.db
        .prepare(
          `INSERT INTO devices (token, session, login, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (token) DO UPDATE SET session = excluded.session, login = excluded.login, created_at = excluded.created_at`,
        )
        .run(token, device.session, device.login.toLowerCase(), now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The push tokens of a session. */
  devicesOfSession(session: string): string[] {
    return (
      this.db.prepare('SELECT token FROM devices WHERE session = ? ORDER BY created_at, token').all(session) as {
        token: string;
      }[]
    ).map((row) => row.token);
  }

  /** The push tokens of every session of `login`, with their session. */
  devicesOf(login: string): Device[] {
    return this.db
      .prepare('SELECT token, session FROM devices WHERE login = ? ORDER BY created_at, token')
      .all(login.toLowerCase()) as unknown as Device[];
  }

  /** The session that has the token now, if any. */
  sessionOfDevice(token: string): string | undefined {
    return (
      this.db.prepare('SELECT session FROM devices WHERE token = ?').get(token) as { session: string } | undefined
    )?.session;
  }

  /** Deletes the token of a session: the phone stops the notifications, or the session ended. */
  removeSessionDevices(session: string): void {
    this.db.prepare('DELETE FROM devices WHERE session = ?').run(session);
  }

  /** Deletes tokens that Expo does not know any more. */
  removeTokens(tokens: readonly string[]): void {
    const remove = this.db.prepare('DELETE FROM devices WHERE token = ?');
    for (const token of tokens) remove.run(token);
  }

  /** The state of the pull request in the last push decision for `login`. */
  pushMark(login: string, pr: Pick<PullRequest, 'repo' | 'number'>): PushMark | undefined {
    const row = this.db
      .prepare('SELECT state, stalled FROM push_marks WHERE login = ? AND key = ?')
      .get(login.toLowerCase(), keyOf(pr)) as { state: string; stalled: number } | undefined;
    return row && { state: row.state, stalled: row.stalled === 1 };
  }

  setPushMark(login: string, pr: Pick<PullRequest, 'repo' | 'number'>, mark: PushMark): void {
    this.db
      .prepare(
        `INSERT INTO push_marks (login, key, state, stalled) VALUES (?, ?, ?, ?)
         ON CONFLICT (login, key) DO UPDATE SET state = excluded.state, stalled = excluded.stalled`,
      )
      .run(login.toLowerCase(), keyOf(pr), mark.state, mark.stalled ? 1 : 0);
  }
}

/** A push token of a phone, and the session that registered it. */
export interface Device {
  token: string;
  session: string;
}

/** What the push notifications last saw of a pull request, for one user: the next change compares with it. */
export interface PushMark {
  state: string;
  stalled: boolean;
}

function toStored(row: { pr: string; snapshot: string | null; error: string | null; read_at: number }): StoredPull {
  return {
    pr: JSON.parse(row.pr) as PullRequest,
    ...(row.snapshot && { snapshot: JSON.parse(row.snapshot) as PullRequestSnapshot }),
    ...(row.error && { error: row.error }),
    readAt: row.read_at,
  };
}
