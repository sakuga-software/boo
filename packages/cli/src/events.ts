import { rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  diffReports,
  hasLeft,
  holdErrors,
  keepLastData,
  newComments,
  personComments,
  requestChanges,
  requestStates,
  STATE_VERSION,
  type RequestOutcome,
  type WatchEvent,
  type WatchState,
} from '@sakuga-software/boo-core/events';
import { buildReport, keyOf, type PullRequestReport, type ReportInput } from '@sakuga-software/boo-core/report';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import type { Owner } from './sessions.js';
import type { Settings } from './settings.js';

// The part of this module that runs anywhere is in core. Each name is listed: a name that the CLI
// also declared would hide the one of core with no error.
export {
  changesOf,
  diffReports,
  holdErrors,
  newComments,
  parseWatchState,
  personComments,
  requestChanges,
  requestStates,
  STATE_VERSION,
  type PersonComment,
  type RequestOutcome,
  type RequestState,
  type WatchEvent,
  type WatchState,
} from '@sakuga-software/boo-core/events';

export interface WatchSources {
  listPullRequests(): Promise<PullRequest[]>;
  fetchPullRequest(pr: PullRequest): Promise<PullRequestSnapshot>;
  /** Reads a short state of each pull request, so that `fetchPullRequest` reads only the ones that changed. */
  probePullRequests?(prs: readonly PullRequest[]): Promise<void>;
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
  return (await readAll(prs, sources, settings, now)).reports;
}

async function readAll(
  prs: readonly PullRequest[],
  sources: WatchSources,
  settings: Settings,
  now: Date,
): Promise<{ inputs: ReportInput[]; reports: PullRequestReport[] }> {
  await sources.probePullRequests?.(prs).catch(() => {});
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
  return { inputs, reports: buildReport(inputs, owners, settings, now, viewer) };
}

/**
 * Writes the state in one step: a write to a temporary file, then a rename. A stop during the write
 * leaves the old state, not a broken file. A rename that fails removes the temporary file.
 */
export async function writeWatchState(path: string, state: WatchState): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Reads the list at each interval and calls `emit` for each change. A pull request that leaves the
 * search result is read once more, so that its `left` event gives the reason. It posts nothing.
 */
export async function watchEvents(
  sources: WatchSources,
  settings: Settings,
  {
    intervalMs,
    signal,
    initial,
    onState,
    snapshots = false,
    onStateError,
  }: {
    intervalMs: number;
    signal: AbortSignal;
    /** The state that an earlier run saved: the first read then gives only the changes since that state. */
    initial?: WatchState | undefined;
    /** Called after each read with the state to keep, for the next run. */
    onState?: ((state: WatchState) => Promise<void>) | undefined;
    /** With `initial`, the first read also gives a `snapshot` line for each pull request. */
    snapshots?: boolean;
    /** Called when `onState` fails, for example on a full disk. */
    onStateError?: ((error: unknown) => void) | undefined;
  },
  emit: (event: WatchEvent) => Promise<void>,
  onListError: (error: unknown) => void,
): Promise<void> {
  let previous: Map<string, PullRequestReport> | undefined = initial
    ? new Map(initial.reports.map((report) => [`${report.repo}#${report.number}`, report]))
    : undefined;
  const failures = new Map<string, number>();
  // The pull requests of the saved state are tracked: one that merged while no watch ran gives its `left` event.
  let tracked = new Map<string, PullRequest>(
    (initial?.reports ?? []).map((report) => [
      `${report.repo}#${report.number}`,
      { repo: report.repo, number: report.number, title: report.title, url: report.url },
    ]),
  );
  // The comments of people that the watch knows, by pull request. The first read of a pull request gives no comment event.
  const seenComments = new Map<string, Set<string>>(
    Object.entries(initial?.comments ?? {}).map(([key, ids]) => [key, new Set(ids)]),
  );
  // The outcome of each review request that the watch knows, by pull request. The first read gives no event either.
  const seenRequests = new Map<string, Map<string, RequestOutcome>>(
    Object.entries(initial?.requests ?? {}).map(([key, outcomes]) => [key, new Map(Object.entries(outcomes))]),
  );
  let first = true;
  while (!signal.aborted) {
    try {
      const listed = await sources.listPullRequests();
      const listedKeys = new Set(listed.map(keyOf));
      const gone = [...tracked.values()].filter((pr) => !listedKeys.has(keyOf(pr)));
      const now = new Date();
      const { inputs, reports: read } = await readAll([...listed, ...gone], sources, settings, now);
      const keyOfReport = (report: PullRequestReport) => `${report.repo}#${report.number}`;
      const goneKeys = new Set(gone.map(keyOf));
      // A pull request that left the search result and that GitHub did not give is read again at the
      // next read. Until then it keeps its last data, and gives no event: it can be merged or closed.
      const unread = new Set(
        read.filter((report) => goneKeys.has(keyOfReport(report)) && report.error).map(keyOfReport),
      );
      // A pull request that left the search result but is still open gives `left` with "unlisted".
      const before = previous && new Map([...previous].filter(([key]) => !unread.has(key)));
      const reports = holdErrors(
        before,
        read.filter((report) => !goneKeys.has(keyOfReport(report)) || hasLeft(report)),
        failures,
      );
      // A stop during the read must not write the events of that read.
      if (signal.aborted) return;
      const events = diffReports(before, reports, now.toISOString());
      if (first && initial && snapshots)
        events.unshift(
          ...reports
            .filter((report) => !hasLeft(report))
            .map((report): WatchEvent => ({
              at: now.toISOString(),
              pr: keyOfReport(report),
              event: 'snapshot',
              ...report,
            })),
        );
      for (const { pr, snapshot } of inputs) {
        if (snapshot?.status !== 'open' && !(snapshot?.status === 'draft' && settings.drafts === 'show')) continue;
        const key = keyOf(pr);
        const requests = requestStates(snapshot, settings, now);
        const comments = personComments(
          snapshot,
          settings.commentEvents,
          new Set(requests.map(({ commentId }) => commentId)),
        );
        const seen = seenComments.get(key);
        if (seen) events.push(...newComments(key, comments, seen, now.toISOString()));
        else seenComments.set(key, new Set(comments.map((comment) => comment.id)));
        const outcomes = seenRequests.get(key);
        if (outcomes) events.push(...requestChanges(key, requests, outcomes, now.toISOString()));
        else seenRequests.set(key, new Map(requests.map(({ id, outcome }) => [id, outcome])));
      }
      for (const event of events) {
        if (signal.aborted) return;
        await emit(event);
      }
      previous = new Map([
        ...reports
          .filter((report) => !hasLeft(report))
          .map((report) => [keyOfReport(report), keepLastData(previous, report)] as const),
        ...[...(previous ?? [])].filter(([key]) => unread.has(key)),
      ]);
      tracked = new Map([...listed, ...gone.filter((pr) => unread.has(keyOf(pr)))].map((pr) => [keyOf(pr), pr]));
      first = false;
      // A pull request that the watch no longer follows needs no comments or requests: the file stays small.
      for (const key of [...seenComments.keys()]) if (!previous.has(key)) seenComments.delete(key);
      for (const key of [...seenRequests.keys()]) if (!previous.has(key)) seenRequests.delete(key);
      // A state that cannot be written is not an error of GitHub: it gets its own message, and the watch goes on.
      await onState?.({
        version: STATE_VERSION,
        reports: [...previous.values()],
        comments: Object.fromEntries([...seenComments].map(([key, ids]) => [key, [...ids]])),
        requests: Object.fromEntries([...seenRequests].map(([key, outcomes]) => [key, Object.fromEntries(outcomes)])),
      }).catch((error: unknown) => onStateError?.(error));
    } catch (error) {
      onListError(error);
    }
    // A signal that aborts during a read stops the wait at once: sleep() rejects if the signal is already aborted.
    await sleep(intervalMs, undefined, { signal }).catch(() => {});
  }
}
