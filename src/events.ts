import { setTimeout as sleep } from 'node:timers/promises';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import { buildReport, keyOf, type PullRequestReport, type ReportInput } from './report.js';
import type { Owner } from './sessions.js';
import type { Settings } from './settings.js';

type Reviewer = PullRequestReport['reviewers'][number];

/** One line of `boo --watch --events`. `pr` is "owner/repo#number". */
export type WatchEvent = { at: string; pr: string } & (
  | ({ event: 'snapshot' | 'entered' } & PullRequestReport)
  | { event: 'state'; from: string; to: string; failing: string[] }
  | { event: 'head'; from: string | null; to: string | null }
  | ({ event: 'review'; reviewer: string; reviewedAt: string | null } & Omit<Reviewer, 'login' | 'at'>)
  | { event: 'check'; check: string; to: 'failing' | 'not failing' }
  | { event: 'left'; reason: string }
);

const sameReview = (a: Reviewer, b: Reviewer) =>
  a.mark === b.mark &&
  a.verdict === b.verdict &&
  a.onHead === b.onHead &&
  a.at === b.at &&
  a.score?.score === b.score?.score &&
  a.score?.total === b.score?.total;

/** Returns the changes of one pull request between two reads. */
export function changesOf(before: PullRequestReport, after: PullRequestReport, at: string): WatchEvent[] {
  const pr = `${after.repo}#${after.number}`;
  const events: WatchEvent[] = [];
  if (before.state !== after.state)
    events.push({ at, pr, event: 'state', from: before.state, to: after.state, failing: after.checks.failing });
  // A read that failed has no data. Its other differences are not changes of the pull request.
  if (after.error) return events;
  if (before.headSha !== after.headSha) events.push({ at, pr, event: 'head', from: before.headSha, to: after.headSha });
  const reviewersBefore = new Map(before.reviewers.map((reviewer) => [reviewer.login, reviewer]));
  for (const reviewer of after.reviewers) {
    const known = reviewersBefore.get(reviewer.login);
    if (known && sameReview(known, reviewer)) continue;
    const { login, at: reviewedAt, ...review } = reviewer;
    events.push({ at, pr, event: 'review', reviewer: login, ...review, reviewedAt });
  }
  const failingBefore = new Set(before.checks.failing);
  const failingAfter = new Set(after.checks.failing);
  for (const check of failingAfter)
    if (!failingBefore.has(check)) events.push({ at, pr, event: 'check', check, to: 'failing' });
  for (const check of failingBefore)
    if (!failingAfter.has(check)) events.push({ at, pr, event: 'check', check, to: 'not failing' });
  return events;
}

const LEFT_STATES = new Set(['merged', 'closed', 'draft']);

/**
 * Returns the events between two reads of the list. `previous` is undefined at the first read: each
 * pull request then gives one `snapshot` line, also a merged one. A pull request that left the list gives `left`, with
 * the state that its last read gave (`merged`, `closed`, `draft`), or `unlisted` if it is still open.
 */
export function diffReports(
  previous: ReadonlyMap<string, PullRequestReport> | undefined,
  next: readonly PullRequestReport[],
  at: string,
): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const report of next) {
    const pr = `${report.repo}#${report.number}`;
    const before = previous?.get(pr);
    if (!previous) events.push({ at, pr, event: 'snapshot', ...report });
    else if (LEFT_STATES.has(report.state)) {
      if (before) events.push({ at, pr, event: 'left', reason: report.state });
    } else if (!before) events.push({ at, pr, event: 'entered', ...report });
    else events.push(...changesOf(before, report, at));
  }
  const listed = new Set(next.map((report) => `${report.repo}#${report.number}`));
  for (const pr of previous?.keys() ?? [])
    if (!listed.has(pr)) events.push({ at, pr, event: 'left', reason: 'unlisted' });
  return events;
}

/**
 * A failed read keeps the data of the last read that worked, with the error. The next read that works
 * then gives the changes since that last data: a review or a check of the time of the error is not lost.
 */
function keepLastData(previous: ReadonlyMap<string, PullRequestReport> | undefined, report: PullRequestReport) {
  const last = previous?.get(`${report.repo}#${report.number}`);
  return report.error && last ? { ...last, state: report.state, error: report.error } : report;
}

export interface WatchSources {
  listPullRequests(): Promise<PullRequest[]>;
  fetchPullRequest(pr: PullRequest): Promise<PullRequestSnapshot>;
  readOwners(): Promise<Map<string, Owner>>;
  /** The login of the user of boo. Only the "ownerOnly" rule of the merge policy reads it. */
  viewerLogin?(): Promise<string | undefined>;
}

/** Reads each pull request. A pull request that GitHub does not give keeps its place, with the error. */
export async function readReport(
  prs: readonly PullRequest[],
  sources: WatchSources,
  settings: Settings,
  now: Date,
): Promise<PullRequestReport[]> {
  const inputs = await Promise.all(
    prs.map(async (pr): Promise<ReportInput> => {
      try {
        return { pr, snapshot: await sources.fetchPullRequest(pr) };
      } catch (error) {
        return { pr, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  // The session records are internal to Claude Code. If they are unreadable, the output shows no session.
  const owners = await sources.readOwners().catch(() => new Map<string, Owner>());
  const viewer = settings.mergePolicy?.ownerOnly ? await sources.viewerLogin?.() : undefined;
  return buildReport(inputs, owners, settings, now, viewer);
}

/**
 * Reads the list at each interval and calls `emit` for each change. A pull request that leaves the
 * search result is read once more, so that its `left` event gives the reason. It posts nothing.
 */
export async function watchEvents(
  sources: WatchSources,
  settings: Settings,
  { intervalMs, signal }: { intervalMs: number; signal: AbortSignal },
  emit: (event: WatchEvent) => Promise<void>,
  onListError: (error: unknown) => void,
): Promise<void> {
  let previous: Map<string, PullRequestReport> | undefined;
  let tracked = new Map<string, PullRequest>();
  while (!signal.aborted) {
    try {
      const listed = await sources.listPullRequests();
      const listedKeys = new Set(listed.map(keyOf));
      const gone = [...tracked.values()].filter((pr) => !listedKeys.has(keyOf(pr)));
      const now = new Date();
      const read = await readReport([...listed, ...gone], sources, settings, now);
      const keyOfReport = (report: PullRequestReport) => `${report.repo}#${report.number}`;
      const goneKeys = new Set(gone.map(keyOf));
      // A pull request that left the search result and that GitHub did not give is read again at the
      // next read. Until then it keeps its last data, and gives no event: it can be merged or closed.
      const unread = new Set(
        read.filter((report) => goneKeys.has(keyOfReport(report)) && report.error).map(keyOfReport),
      );
      // A pull request that left the search result but is still open gives `left` with "unlisted".
      const reports = read.filter((report) => !goneKeys.has(keyOfReport(report)) || LEFT_STATES.has(report.state));
      const before = previous && new Map([...previous].filter(([key]) => !unread.has(key)));
      // A stop during the read must not write the events of that read.
      if (signal.aborted) return;
      for (const event of diffReports(before, reports, now.toISOString())) {
        if (signal.aborted) return;
        await emit(event);
      }
      previous = new Map([
        ...reports
          .filter((report) => !LEFT_STATES.has(report.state))
          .map((report) => [keyOfReport(report), keepLastData(previous, report)] as const),
        ...[...(previous ?? [])].filter(([key]) => unread.has(key)),
      ]);
      tracked = new Map([...listed, ...gone.filter((pr) => unread.has(keyOf(pr)))].map((pr) => [keyOf(pr), pr]));
    } catch (error) {
      onListError(error);
    }
    // A signal that aborts during a read stops the wait at once: sleep() rejects if the signal is already aborted.
    await sleep(intervalMs, undefined, { signal }).catch(() => {});
  }
}
