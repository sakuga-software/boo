import { randomBytes } from 'node:crypto';
import {
  diffReports,
  hasLeft,
  newComments,
  personComments,
  requestChanges,
  requestStates,
  type RequestOutcome,
  type WatchEvent,
} from '@sakuga-software/boo-core/events';
import { buildReport, type PullRequestReport, type ReportInput } from '@sakuga-software/boo-core/report';
import type { Settings } from '@sakuga-software/boo-core/settings';
import type { StateStore, StoredPull } from './state-store.js';

/** The reports of a user, as `GET /state` gives them. */
export interface UserState {
  /** Changes each time the reports change: `<boot>-<count>`. A restart of the relay gives a new boot. */
  cursor: string;
  /** The time of the computation. */
  at: string;
  reports: PullRequestReport[];
}

/**
 * Called when the reports of a user change, with the reports before and after, and the events of the
 * change in the vocabulary of `boo --watch --events`.
 */
export type ReportListener = (
  login: string,
  before: UserState | undefined,
  after: UserState,
  events: readonly WatchEvent[],
) => void;

/** The changes of one cursor, kept for a stream that resumes. */
interface LogEntry {
  count: number;
  events: readonly WatchEvent[];
}

/** The cursors that a stream can resume from: older ones get a reset. */
export const LOG_SIZE = 200;

interface UserMemory extends UserState {
  key: string;
  count: number;
  log: LogEntry[];
  /** The comments of people and the outcomes of the review requests that the user knows, by pull request. */
  comments: Map<string, Set<string>>;
  requests: Map<string, Map<string, RequestOutcome>>;
}

/**
 * A report that only its idle minutes changed is the same report: else the cursor would move each
 * minute for each pull request with a head commit.
 */
const reportKey = ({ idleMinutes: _idle, ...report }: PullRequestReport) => JSON.stringify(report);
const changeKey = (reports: readonly PullRequestReport[]) => JSON.stringify(reports.map(reportKey));
const prOf = (report: Pick<PullRequestReport, 'repo' | 'number'>) => `${report.repo}#${report.number}`;

/** The input of `buildReport`. A failed read keeps the last snapshot that worked; the error shows only with none. */
const inputOf = ({ pr, snapshot, error }: StoredPull): ReportInput =>
  snapshot ? { pr, snapshot } : { pr, error: error ?? 'Not read yet' };

/**
 * Computes the reports of each user with `buildReport` of core (D1: the logic runs on the relay), with
 * no local session: `owners` is empty. The cursor moves only when a report changes.
 */
export class Reports {
  private readonly states = new Map<string, UserMemory>();
  private readonly boot = randomBytes(4).toString('hex');
  private readonly listeners = new Set<ReportListener>();

  constructor(
    private readonly store: StateStore,
    private readonly now = Date.now,
  ) {}

  onChange(listener: ReportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The last reports of `login`, computed now if there are none yet. */
  get(login: string): UserState {
    const user = login.toLowerCase();
    const known = this.states.get(user);
    return known ? strip(known) : this.refresh(user);
  }

  /** Computes the reports of `login` again. The cursor moves if they changed. */
  refresh(login: string): UserState {
    const user = login.toLowerCase();
    const config = this.store.config(user);
    const now = new Date(this.now());
    const at = now.toISOString();
    const pulls = config ? this.store.pullsOf(user) : [];
    const reports = config ? buildReport(pulls.map(inputOf), new Map(), config.settings, now, user) : [];
    const key = changeKey(reports);
    const before = this.states.get(user);
    const comments = before?.comments ?? new Map<string, Set<string>>();
    const requests = before?.requests ?? new Map<string, Map<string, RequestOutcome>>();
    // The first computation gives no event: `GET /state` gives the reports.
    const events = before ? this.eventsOf(before, reports, at) : [];
    if (config) events.push(...talkOf(pulls, config.settings, comments, requests, now, Boolean(before)));
    const moved = Boolean(before) && (before!.key !== key || events.length > 0);
    const count = before ? before.count + (moved ? 1 : 0) : 0;
    const log = before?.log ?? [];
    if (moved) {
      log.push({ count, events });
      if (log.length > LOG_SIZE) log.shift();
    }
    const state: UserMemory = { cursor: `${this.boot}-${count}`, at, reports, key, count, log, comments, requests };
    this.states.set(user, state);
    if (!before || moved)
      for (const listener of this.listeners) listener(user, before && strip(before), strip(state), events);
    return strip(state);
  }

  /**
   * The events after `cursor`, each with the cursor of its change, or 'reset' if the relay cannot give
   * them all: a cursor of another boot of the relay, or older than the kept changes.
   */
  since(login: string, cursor: string): { cursor: string; event: WatchEvent }[] | 'reset' {
    const state = this.states.get(login.toLowerCase());
    const match = /^([0-9a-f]+)-(\d+)$/.exec(cursor);
    if (!state || !match || match[1] !== this.boot) return 'reset';
    const from = Number(match[2]);
    if (from > state.count) return 'reset';
    if (from === state.count) return [];
    const first = state.log[0];
    if (!first || first.count > from + 1) return 'reset';
    return state.log
      .filter((entry) => entry.count > from)
      .flatMap((entry) => entry.events.map((event) => ({ cursor: `${this.boot}-${entry.count}`, event })));
  }

  /**
   * The changes of the reports, as `diffReports` of core gives them. A report that changed with no
   * event of its own (it stalls, the CodeRabbit note changes) gives a `snapshot` of the whole report.
   */
  private eventsOf(before: UserMemory, reports: readonly PullRequestReport[], at: string): WatchEvent[] {
    // As in the watch of the CLI: a pull request that left gives its `left` event once.
    const previous = new Map(
      before.reports.filter((report) => !hasLeft(report)).map((report) => [prOf(report), report]),
    );
    const events = diffReports(previous, reports, at);
    const named = new Set(events.map((event) => event.pr));
    const old = new Map(before.reports.map((report) => [prOf(report), reportKey(report)]));
    for (const report of reports) {
      const pr = prOf(report);
      const known = old.get(pr);
      if (known !== undefined && known !== reportKey(report) && !named.has(pr) && !hasLeft(report))
        events.push({ at, pr, event: 'snapshot', ...report });
    }
    return events;
  }
  /** Computes the reports of every user again: a timer calls it for the states that depend on time. */
  refreshAll(): void {
    for (const login of this.store.logins()) this.refresh(login);
  }

  /** Computes again the reports of the users that follow the pull request, after a read. */
  refreshFollowers(pr: { repo: string; number: number }): void {
    for (const login of this.store.followers(pr)) this.refresh(login);
  }
}

const strip = ({ cursor, at, reports }: UserState): UserState => ({ cursor, at, reports });

/**
 * The `comment` and `review-request` events of the open pull requests, as the watch of the CLI gives
 * them. The first computation of a pull request only records what it knows.
 */
function talkOf(
  pulls: readonly StoredPull[],
  settings: Settings,
  comments: Map<string, Set<string>>,
  requests: Map<string, Map<string, RequestOutcome>>,
  now: Date,
  emit: boolean,
): WatchEvent[] {
  const events: WatchEvent[] = [];
  const at = now.toISOString();
  const open = new Set<string>();
  for (const { pr, snapshot } of pulls) {
    if (snapshot?.status !== 'open' && !(snapshot?.status === 'draft' && settings.drafts === 'show')) continue;
    const key = prOf(pr);
    open.add(key);
    const states = requestStates(snapshot, settings, now);
    const people = personComments(snapshot, settings.commentEvents, new Set(states.map(({ commentId }) => commentId)));
    const seen = comments.get(key);
    if (seen && emit) events.push(...newComments(key, people, seen, at));
    else comments.set(key, new Set([...(seen ?? []), ...people.map((comment) => comment.id)]));
    const outcomes = requests.get(key);
    if (outcomes && emit) events.push(...requestChanges(key, states, outcomes, at));
    else requests.set(key, new Map([...(outcomes ?? []), ...states.map(({ id, outcome }) => [id, outcome] as const)]));
  }
  // A pull request that is no longer open needs no memory of its comments.
  for (const key of [...comments.keys()]) if (!open.has(key)) comments.delete(key);
  for (const key of [...requests.keys()]) if (!open.has(key)) requests.delete(key);
  return events;
}

/** The reports of the repositories that the user reads through the App. */
export const readableReports = (state: UserState, repos: ReadonlySet<string>): UserState => ({
  ...state,
  reports: state.reports.filter((report) => repos.has(report.repo.toLowerCase())),
});
