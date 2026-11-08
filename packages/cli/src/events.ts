import { rename, rm, writeFile } from 'node:fs/promises';
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
  | { event: 'check'; check: string; to: 'failing' | 'not failing'; reviewerError?: true; error?: string }
  | { event: 'left'; reason: string; mergedBy?: string | null; mergedAt?: string | null }
  | { event: 'restack'; oldBase: string; base: string | null; parent: string | null }
  | ({ event: 'ready-for-owner' } & NonNullable<PullRequestReport['needsOwner']>)
  | { event: 'policy'; policy: PullRequestReport['policy']; added: string[]; removed: string[] }
  | { event: 'comment'; author: string; createdAt: string; body: string; thread: boolean }
  | ({ event: 'review-request' } & Omit<RequestState, 'id' | 'commentId'>)
  | ({ event: 'findings' } & PullRequestReport['findings'])
);

/**
 * Where a review asked by comment stands, from the first that applies:
 * - `answered`: a review of the bot came after the comment;
 * - `failed`: the bot put 😕 on the comment, or posted a comment after it that says it failed;
 * - `acknowledged`: the bot put 👀 on the comment;
 * - `stale`: no 👀, no 😕 and no review after `reviewRequestTimeoutMinutes`;
 * - `asked`: none of these yet.
 */
export type RequestOutcome = 'asked' | 'acknowledged' | 'failed' | 'answered' | 'stale';

/** A comment that asks a bot for a review, and where it stands. `reason` gives the cause of a failure. */
export interface RequestState {
  /** The request: the comment and the bot. One comment can ask two bots. */
  id: string;
  /** The comment of the request, as `personComments` names it. */
  commentId: string;
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
  const group = reviewerGroup(settings.mergePolicy);
  const requests = reviewRequests(snapshot, group);
  const levels = group?.levels ?? [];
  return requests.map(({ comment, bot, member }) => {
    const after = (at: string) => at > comment.created_at;
    // A failure notice answers the last request before it: a notice after the next request of the same bot is not for this one.
    const next = requests.find((other) => other.bot === bot && other.comment.created_at > comment.created_at);
    const beforeNext = (at: string) => !next || at <= next.comment.created_at;
    // Only a reaction of the bot counts: a 👀 or a 😕 of a person is no answer. The read gives the
    // first 50 reactors: with more, the bot can be one of the others, so the reaction counts.
    const reacted = (content: string) =>
      (comment.reactions ?? []).some(
        (reaction) => reaction.content === content && (reaction.logins.some(member) || reaction.more),
      );
    // A failure notice that names another level than the request is for another review, such as the review of a push.
    const levelOf = (text: string) => levels.find((level) => new RegExp(`\\b${level}\\b`, 'i').test(text));
    const asked = levelOf(comment.body);
    const forThisReview = (notice: string) => {
      const named = levelOf(
        notice
          .split(/\n\s*\n/)
          .slice(0, 2)
          .join('\n'),
      );
      return !asked || !named || named.toLowerCase() === asked.toLowerCase();
    };
    // GitHub gives the times to the second: a review in the same second as the request answers it.
    // A review after the next request to the same bot answers that one, not this one.
    const answered = snapshot.reviews.some(
      (review) =>
        review.user &&
        member(review.user.login) &&
        !review.threadReply &&
        review.submitted_at >= comment.created_at &&
        (!next || review.submitted_at < next.comment.created_at),
    );
    const failure = snapshot.comments.find(
      (post) =>
        post.user &&
        member(post.user.login) &&
        after(post.created_at) &&
        beforeNext(post.created_at) &&
        forThisReview(post.body) &&
        FAILURE.test(post.body.trimStart().split('\n')[0]!),
    );
    const minutes = (now.getTime() - Date.parse(comment.created_at)) / 60_000;
    const failed = Boolean(failure) || reacted('CONFUSED');
    const outcome = ((): RequestOutcome => {
      if (answered) return 'answered';
      if (failed) return 'failed';
      if (reacted('EYES')) return 'acknowledged';
      // Only 👀 and 😕 are answers of the bot: a 👍 of a person does not keep the request alive.
      return minutes >= settings.reviewRequestTimeoutMinutes ? 'stale' : 'asked';
    })();
    return {
      id: `comment:${comment.id ?? comment.created_at}:${bot}`,
      commentId: `comment:${comment.id ?? comment.created_at}`,
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
  for (const { id, commentId: _comment, ...state } of states) {
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

// GitHub can give the threads in another order: the list of the findings with no answer is compared sorted.
const findingsKey = ({ unanswered, ...counts }: PullRequestReport['findings']) =>
  JSON.stringify({ ...counts, unanswered: unanswered.map((finding) => JSON.stringify(finding)).sort() });

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
  // A read without the threads knows less: it gives no event. A read that has the threads again tells what they hold.
  if (
    !(before.findings.threadsRead && !after.findings.threadsRead) &&
    findingsKey(before.findings) !== findingsKey(after.findings)
  )
    events.push({ at, pr, event: 'findings', ...after.findings });
  // A rule of the merge policy that the pull request starts or stops to miss: a new open bot thread,
  // a score that comes, a proof that the agent posts. The notes compare as a set: their order is the settings order.
  const notesBefore = new Set(before.policy.map(({ note }) => note));
  const notesAfter = new Set(after.policy.map(({ note }) => note));
  const added = [...notesAfter].filter((note) => !notesBefore.has(note));
  const removed = [...notesBefore].filter((note) => !notesAfter.has(note));
  if (added.length + removed.length > 0) events.push({ at, pr, event: 'policy', policy: after.policy, added, removed });
  // One event when the pull request starts to wait only for its owner, not one at each read.
  if (after.readyForOwner && !before.readyForOwner && after.needsOwner)
    events.push({ at, pr, event: 'ready-for-owner', ...after.needsOwner });
  const restack = after.stack.restack;
  if (restack && restack.at !== before.stack.restack?.at)
    events.push({ at, pr, event: 'restack', oldBase: restack.oldBase, base: after.base, parent: before.stack.parent });
  const failingBefore = new Set(before.checks.failing);
  const failingAfter = new Set(after.checks.failing);
  const reviewerErrors = new Map(after.checks.reviewerErrors.map(({ check, error }) => [check, error]));
  for (const check of failingAfter)
    if (!failingBefore.has(check)) {
      const error = reviewerErrors.get(check);
      events.push({
        at,
        pr,
        event: 'check',
        check,
        to: 'failing',
        ...(reviewerErrors.has(check) && { reviewerError: true as const }),
        ...(error && { error }),
      });
    }
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

/** The state that `--state <file>` keeps between two runs of the watch. */
export interface WatchState {
  version: number;
  /** The last data of each pull request that the watch follows. */
  reports: PullRequestReport[];
  /** The comments of people that the watch knows, by pull request. */
  comments: Record<string, string[]>;
  /** The outcome of each review request that the watch knows, by pull request. */
  requests: Record<string, Record<string, RequestOutcome>>;
}

/** A state of another version is not read: its reports can lack keys, and give false changes. */
export const STATE_VERSION = 1;

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

/** Reads a saved state. A missing file, another version or a broken file gives no state: the watch starts as new. */
export function parseWatchState(text: string | undefined): WatchState | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<WatchState>;
    if (value.version !== STATE_VERSION || !Array.isArray(value.reports)) return undefined;
    // A file edited by hand can hold anything: a report needs at least its repository and its number.
    const reports = (value.reports as unknown[]).filter((report): report is PullRequestReport => {
      const item = report as Partial<PullRequestReport> | null;
      return (
        typeof item === 'object' &&
        item !== null &&
        typeof item.repo === 'string' &&
        Number.isInteger(item.number) &&
        Array.isArray(item.reviewers) &&
        typeof item.checks === 'object' &&
        item.checks !== null
      );
    });
    const record = <T>(field: unknown): Record<string, T> =>
      typeof field === 'object' && field !== null && !Array.isArray(field) ? (field as Record<string, T>) : {};
    return {
      version: STATE_VERSION,
      reports,
      comments: record<string[]>(value.comments),
      requests: record<Record<string, RequestOutcome>>(value.requests),
    };
  } catch {
    return undefined;
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
        read.filter((report) => !goneKeys.has(keyOfReport(report)) || LEFT_STATES.has(report.state)),
        failures,
      );
      // A stop during the read must not write the events of that read.
      if (signal.aborted) return;
      const events = diffReports(before, reports, now.toISOString());
      if (first && initial && snapshots)
        events.unshift(
          ...reports
            .filter((report) => !LEFT_STATES.has(report.state))
            .map((report): WatchEvent => ({
              at: now.toISOString(),
              pr: keyOfReport(report),
              event: 'snapshot',
              ...report,
            })),
        );
      for (const { pr, snapshot } of inputs) {
        if (snapshot?.status !== 'open') continue;
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
          .filter((report) => !LEFT_STATES.has(report.state))
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
