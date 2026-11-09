import { randomBytes } from 'node:crypto';
import { buildReport, type PullRequestReport, type ReportInput } from '@sakuga-software/boo-core/report';
import type { StateStore, StoredPull } from './state-store.js';

/** The reports of a user, as `GET /state` gives them. */
export interface UserState {
  /** Changes each time the reports change: `<boot>-<count>`. A restart of the relay gives a new boot. */
  cursor: string;
  /** The time of the computation. */
  at: string;
  reports: PullRequestReport[];
}

/** Called when the reports of a user change, with the reports before and after. */
export type ReportListener = (login: string, before: UserState | undefined, after: UserState) => void;

/**
 * A report that only its idle minutes changed is the same report: else the cursor would move each
 * minute for each pull request with a head commit.
 */
const changeKey = (reports: readonly PullRequestReport[]) =>
  JSON.stringify(reports.map(({ idleMinutes: _idle, ...report }) => report));

/** The input of `buildReport`. A failed read keeps the last snapshot that worked; the error shows only with none. */
const inputOf = ({ pr, snapshot, error }: StoredPull): ReportInput =>
  snapshot ? { pr, snapshot } : { pr, error: error ?? 'Not read yet' };

/**
 * Computes the reports of each user with `buildReport` of core (D1: the logic runs on the relay), with
 * no local session: `owners` is empty. The cursor moves only when a report changes.
 */
export class Reports {
  private readonly states = new Map<string, UserState & { key: string; count: number }>();
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
    const reports = config
      ? buildReport(this.store.pullsOf(user).map(inputOf), new Map(), config.settings, now, user)
      : [];
    const key = changeKey(reports);
    const before = this.states.get(user);
    const count = before ? before.count + (before.key === key ? 0 : 1) : 0;
    const state = { cursor: `${this.boot}-${count}`, at: now.toISOString(), reports, key, count };
    this.states.set(user, state);
    if (before?.key !== key)
      for (const listener of this.listeners) listener(user, before && strip(before), strip(state));
    return strip(state);
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

/** The reports of the repositories that the user reads through the App. */
export const readableReports = (state: UserState, repos: ReadonlySet<string>): UserState => ({
  ...state,
  reports: state.reports.filter((report) => repos.has(report.repo.toLowerCase())),
});
