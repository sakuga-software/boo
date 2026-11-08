import { setTimeout as sleep } from 'node:timers/promises';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import { reviewerGroup, reviewRequests } from './policy.js';
import { isBotLogin } from './reviewers.js';
import { buildReport, keyOf, type PullRequestReport, type ReportInput } from './report.js';
import type { Owner } from './sessions.js';
import type { Settings } from './settings.js';

type Reviewer = PullRequestReport['reviewers'][number];

/** One line of `boo --watch --events`. `pr` is "owner/repo#number". */
export type WatchEvent = { at: string; pr: string } & (
  | ({ event: 'snapshot' | 'entered' } & PullRequestReport)
  | { event: 'state'; from: string; to: string; failing: string[]; error?: string }
  | { event: 'head'; from: string | null; to: string | null }
  | ({ event: 'review'; reviewer: string; reviewedAt: string | null } & Omit<Reviewer, 'login' | 'at'>)
  | { event: 'check'; check: string; to: 'failing' | 'not failing' }
  | { event: 'left'; reason: string; mergedBy?: string | null; mergedAt?: string | null }
  | { event: 'restack'; oldBase: string; base: string | null; parent: string | null }
  | { event: 'comment'; author: string; createdAt: string; body: string; thread: boolean }
  | ({ event: 'review-request' } & Omit<RequestState, 'id'>)
);

/**
 * Where a review asked by comment stands, from the first that applies:
 * - `answered`: a review of the bot came after the comment;
 * - `failed`: the bot put 😕 on the comment, or posted a comment after it that says it failed;
 * - `acknowledged`: the bot put 👀 on the comment;
 * - `stale`: no reaction and no review after `reviewRequestTimeoutMinutes`;
 * - `asked`: none of these yet.
 */
export type RequestOutcome = 'asked' | 'acknowledged' | 'failed' | 'answered' | 'stale';

/** A comment that asks a bot for a review, and where it stands. `reason` gives the cause of a failure. */
export interface RequestState {
  id: string;
  bot: string;
  author: string;
  createdAt: string;
  body: string;
  outcome: RequestOutcome;
  reason?: string;
}

// A failure notice of a review bot says so on its first line: "**Kentō · review en échec**", "Review failed",
// a quota or a usage limit. A bare "error" or "failed" can be the text of a walkthrough.
const FAILURE =
  /review (?:en )?échec|échec de (?:la )?review|review failed|failed to review|unable to review|quota|usage limit|rate.limit|limit reached/i;
const REASON_LENGTH = 300;
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** The line of a failure comment that gives its cause, such as "Raison : `…`", else its first paragraph. */
function reasonOf(body: string): string {
  const line = body.split('\n').find((text) => /^\s*(?:raison|reason|cause|error)\b/i.test(text.replace(/[*_`]/g, '')));
  const text = (line ?? body.trimStart().split(/\n\s*\n/)[0]!).replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
  return clip(text, REASON_LENGTH);
}

/** Gives each review asked by comment on the pull request, with where it stands at `now`. */
export function requestStates(
  snapshot: Pick<PullRequestSnapshot, 'reviews' | 'comments'>,
  settings: Pick<Settings, 'mergePolicy' | 'reviewRequestTimeoutMinutes'>,
  now: Date,
): RequestState[] {
  const requests = reviewRequests(snapshot, reviewerGroup(settings.mergePolicy));
  return requests.map(({ comment, bot, member }) => {
    const after = (at: string) => at > comment.created_at;
    // A failure notice answers the last request before it: a notice after the next request of the same bot is not for this one.
    const next = requests.find((other) => other.bot === bot && other.comment.created_at > comment.created_at);
    const beforeNext = (at: string) => !next || at <= next.comment.created_at;
    const reactions = comment.reactions ?? [];
    const answered = snapshot.reviews.some(
      (review) => review.user && member(review.user.login) && !review.threadReply && after(review.submitted_at),
    );
    const failure = snapshot.comments.find(
      (post) =>
        post.user &&
        member(post.user.login) &&
        after(post.created_at) &&
        beforeNext(post.created_at) &&
        FAILURE.test(post.body.trimStart().split('\n')[0]!),
    );
    const minutes = (now.getTime() - Date.parse(comment.created_at)) / 60_000;
    const failed = Boolean(failure) || reactions.includes('CONFUSED');
    const outcome = ((): RequestOutcome => {
      if (answered) return 'answered';
      if (failed) return 'failed';
      if (reactions.includes('EYES')) return 'acknowledged';
      return reactions.length === 0 && minutes >= settings.reviewRequestTimeoutMinutes ? 'stale' : 'asked';
    })();
    return {
      id: `comment:${comment.id ?? comment.created_at}`,
      bot,
      author: comment.user!.login,
      createdAt: comment.created_at,
      body: clip(comment.body, BODY_LENGTH),
      outcome,
      ...(outcome === 'failed' && { reason: failure ? reasonOf(failure.body) : 'the bot reacted with 😕' }),
    };
  });
}

/**
 * Gives one `review-request` event for each request whose outcome is new, and keeps the outcomes in
 * `known`. A request that `known` does not hold is new too.
 */
export function requestChanges(
  pr: string,
  states: readonly RequestState[],
  known: Map<string, RequestOutcome>,
  at: string,
): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const { id, ...state } of states) {
    if (known.get(id) === state.outcome) continue;
    known.set(id, state.outcome);
    events.push({ at, pr, event: 'review-request', ...state });
  }
  return events;
}

/** A comment of a person on a pull request: a conversation comment, the body of a review, or a line comment. */
export interface PersonComment {
  id: string;
  author: string;
  createdAt: string;
  body: string;
  thread: boolean;
}

const BODY_LENGTH = 200;

/**
 * The comments of the people on a pull request. A bot, the author of the pull request and the
 * ignored logins are not people here: an agent posts as the author or as a bot. A comment with an
 * ignored marker is not a comment of a person: an agent can post with the account of a person.
 */
export function personComments(
  snapshot: PullRequestSnapshot,
  { ignoreLogins = [], ignoreMarkers = [] }: Partial<NonNullable<Settings['commentEvents']>> = {},
  /** The comments that are not remarks: the review requests, which give `review-request` events. */
  commands: ReadonlySet<string> = new Set(),
): PersonComment[] {
  const skip = new Set([snapshot.author, ...ignoreLogins].map((login) => login.toLowerCase()));
  const person = (login: string | undefined): login is string =>
    Boolean(login) && !isBotLogin(login!) && !skip.has(login!.toLowerCase());
  const marked = (body: string) => ignoreMarkers.some((marker) => body.includes(marker));
  const comments: PersonComment[] = [];
  for (const comment of snapshot.comments)
    if (person(comment.user?.login))
      comments.push({
        id: `comment:${comment.id ?? comment.created_at}`,
        author: comment.user!.login,
        createdAt: comment.created_at,
        body: comment.body,
        thread: false,
      });
  for (const review of snapshot.reviews) {
    if (!person(review.user?.login)) continue;
    const author = review.user!.login;
    if (review.body?.trim())
      comments.push({
        id: `review:${author}:${review.submitted_at}`,
        author,
        createdAt: review.submitted_at,
        body: review.body,
        thread: false,
      });
    for (const line of review.lineComments ?? [])
      comments.push({ id: `line:${line.id}`, author, createdAt: line.created_at, body: line.body, thread: true });
  }
  return comments
    .filter(({ id, body }) => !marked(body) && !commands.has(id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Gives one `comment` event for each comment of a person that `seen` does not hold, and adds it to `seen`. */
export function newComments(
  pr: string,
  comments: readonly PersonComment[],
  seen: Set<string>,
  at: string,
): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const { id, author, createdAt, body, thread } of comments) {
    if (seen.has(id)) continue;
    seen.add(id);
    const text = body.length > BODY_LENGTH ? `${body.slice(0, BODY_LENGTH - 1)}…` : body;
    events.push({ at, pr, event: 'comment', author, createdAt, body: text, thread });
  }
  return events;
}

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
    events.push({
      at,
      pr,
      event: 'state',
      from: before.state,
      to: after.state,
      failing: after.checks.failing,
      ...(after.error && { error: after.error }),
    });
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
  const restack = after.stack.restack;
  if (restack && restack.at !== before.stack.restack?.at)
    events.push({ at, pr, event: 'restack', oldBase: restack.oldBase, base: after.base, parent: before.stack.parent });
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
      if (before)
        events.push({
          at,
          pr,
          event: 'left',
          reason: report.state,
          ...(report.state === 'merged' && { mergedBy: report.mergedBy, mergedAt: report.mergedAt }),
        });
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

/** GitHub fails one read now and then. A pull request goes to `error` only after this count of failed reads in a row. */
export const ERROR_AFTER_READS = 2;

/**
 * Gives the last report in place of a failed read, until the pull request has `ERROR_AFTER_READS`
 * failed reads in a row. `failures` keeps the count of each pull request from one read to the next.
 */
export function holdErrors(
  previous: ReadonlyMap<string, PullRequestReport> | undefined,
  reports: readonly PullRequestReport[],
  failures: Map<string, number>,
): PullRequestReport[] {
  const keys = new Set(reports.map((report) => `${report.repo}#${report.number}`));
  for (const key of failures.keys()) if (!keys.has(key)) failures.delete(key);
  return reports.map((report) => {
    const key = `${report.repo}#${report.number}`;
    if (!report.error) {
      failures.delete(key);
      return report;
    }
    const count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    const last = previous?.get(key);
    return last && !last.error && count < ERROR_AFTER_READS ? last : report;
  });
}

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
  const failures = new Map<string, number>();
  let tracked = new Map<string, PullRequest>();
  // The comments of people that the watch knows, by pull request. The first read of a pull request gives no comment event.
  const seenComments = new Map<string, Set<string>>();
  // The outcome of each review request that the watch knows, by pull request. The first read gives no event either.
  const seenRequests = new Map<string, Map<string, RequestOutcome>>();
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
        read.filter((report) => !goneKeys.has(keyOfReport(report)) || LEFT_STATES.has(report.state)),
        failures,
      );
      // A stop during the read must not write the events of that read.
      if (signal.aborted) return;
      const events = diffReports(before, reports, now.toISOString());
      for (const { pr, snapshot } of inputs) {
        if (snapshot?.status !== 'open') continue;
        const key = keyOf(pr);
        const requests = requestStates(snapshot, settings, now);
        const comments = personComments(snapshot, settings.commentEvents, new Set(requests.map(({ id }) => id)));
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
