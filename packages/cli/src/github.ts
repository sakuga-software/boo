import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { requestText, type Request } from '@sakuga-software/boo-core/actions';
import {
  PROBE_KEYS,
  probeQuery,
  readPullRequestWith,
  type ExtraFields,
  type PullRequest,
  type PullRequestSnapshot,
  type Variables,
} from '@sakuga-software/boo-core/github';
import type { Check } from '@sakuga-software/boo-core/reviewers';
import { cachedRead, cacheDir, DiskCache, type ReadCache } from './cache.js';

export * from '@sakuga-software/boo-core/github';

const execFileAsync = promisify(execFile);

async function gh(args: string[], { timeout = 0 }: { timeout?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024, timeout });
    return stdout;
  } catch (error) {
    const { stderr, stdout } = error as { stderr?: string; stdout?: string };
    throw Object.assign(new Error(stderr?.trim() || (error as Error).message), { stdout });
  }
}

export interface SearchOptions {
  org: string;
  authors: string[];
  /** The full names of the repositories to watch. Empty or undefined: every repository of the organization. */
  repos?: string[];
  since?: string;
  /** Keep the drafts in the list. */
  drafts?: boolean;
}

interface SearchResult {
  repository: { nameWithOwner: string };
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
}

/**
 * Lists the open pull requests. If GitHub refuses the search for a rate limit, gives the last list that a
 * run of boo on this machine read, of any age.
 */
export async function listPullRequests(options: SearchOptions): Promise<PullRequest[]> {
  return listOrLast(cache, listKey(options), async () => {
    const refusedUntil = pointsOutUntil(await readRateLimit());
    if (refusedUntil) throw new QuotaError(quotaMessage(refusedUntil), refusedUntil);
    try {
      return await searchAll(options);
    } catch (error) {
      if (!(error instanceof Error) || !isRateLimited(error.message)) throw error;
      const { until, secondary } = await recordRefusal();
      throw new QuotaError(quotaMessage(until, secondary), until);
    }
  });
}

/** The cache key of a list. Two runs with the same options share their list. */
export const listKey = ({ org, authors, repos = [], since, drafts }: SearchOptions) =>
  `list-${createHash('sha256')
    .update(JSON.stringify([org, [...authors].sort(), [...repos].sort(), since ?? '', ...(drafts ? ['drafts'] : [])]))
    .digest('hex')
    .slice(0, 16)}`;

/**
 * Reads the list with `read` and keeps it. If `read` fails with a `QuotaError`, returns the last kept
 * list. With no kept list, the error stays.
 */
export async function listOrLast(
  store: Pick<ReadCache, 'get' | 'set'>,
  key: string,
  read: () => Promise<PullRequest[]>,
): Promise<PullRequest[]> {
  try {
    const list = await read();
    await store.set(key, list);
    return list;
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error;
    const last = await store.get<PullRequest[]>(key, Infinity);
    if (!last) throw error;
    return last.value;
  }
}

/** The GitHub search has no OR between two authors: each author is one search. */
async function searchAll({ org, authors, repos = [], since, drafts }: SearchOptions): Promise<PullRequest[]> {
  const searches = await Promise.all(
    authors.map((author) => searchPullRequests({ org, author, repos, ...(since && { since }) })),
  );
  return mergeSearches(searches, drafts).map((result) => ({
    repo: result.repository.nameWithOwner,
    number: result.number,
    title: result.title,
    url: result.url,
  }));
}

/** The search takes the owner and the repositories with AND: a repository of another owner gives nothing. */
export function searchScope(org: string, repos: string[]): string[] {
  if (repos.length > 0) return repos.flatMap((repo) => ['--repo', repo]);
  return org ? ['--owner', org] : [];
}

export function mergeSearches<T extends Pick<SearchResult, 'url' | 'isDraft' | 'updatedAt'>>(
  searches: T[][],
  drafts = false,
): T[] {
  const byUrl = new Map(searches.flat().map((result) => [result.url, result]));
  return [...byUrl.values()]
    .filter((result) => drafts || !result.isDraft)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function searchPullRequests({
  org,
  author,
  repos,
  since,
}: {
  org: string;
  author: string;
  repos: string[];
  since?: string;
}): Promise<SearchResult[]> {
  const output = await gh([
    'search',
    'prs',
    ...searchScope(org, repos),
    '--author',
    author,
    '--state',
    'open',
    ...(since ? ['--created', `>=${since}`] : []),
    '--sort',
    'updated',
    // 1000 is the most results that the GitHub search gives.
    '--limit',
    '1000',
    '--json',
    'repository,number,title,url,isDraft,updatedAt',
  ]);
  return JSON.parse(output) as SearchResult[];
}

export const fingerprintOf = (node: Record<string, unknown>) =>
  createHash('sha256')
    .update(JSON.stringify(PROBE_KEYS.map((key) => node[key] ?? null)))
    .digest('hex')
    .slice(0, 16);

/** The GraphQL points of the account: GitHub gives `limit` points each hour, and resets them at `resetAt`. */
export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

/** True if less than 20 % of the GraphQL points remain. The watch then slows down until the reset. */
export const lowOnPoints = (rate: RateLimit | undefined) => Boolean(rate && rate.remaining < rate.limit * 0.2);

// A read with its pages costs a few points. Below this count, a read can fail half way.
const POINTS_FLOOR = 10;

/** Returns the time that the queries work again, if a query fails now for a rate limit. */
export function pointsOutUntil(rate: RateLimit | undefined, now = new Date()): string | undefined {
  return rate && rate.remaining < POINTS_FLOOR && new Date(rate.resetAt) > now ? rate.resetAt : undefined;
}

/** GitHub refuses the query because of a rate limit: the GraphQL points, or a secondary limit. */
export class QuotaError extends Error {
  constructor(
    message: string,
    readonly until?: string,
  ) {
    super(message);
  }
}

export const isRateLimited = (message: string) => /rate limit/i.test(message);

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The error of a query that GitHub refuses for a rate limit. */
export const quotaMessage = (until: string | undefined, secondary = false) =>
  `GitHub refuses the GraphQL queries of this account${until ? ` until ${clock(until)}` : ''}: ${
    secondary ? 'secondary rate limit, too many queries in a short time' : 'rate limit'
  }`;

/** Returns a function that runs at most `max` tasks at the same time. The other tasks wait in order. */
export function concurrencyLimit(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    // A task that ends gives its slot to the next waiting task, so the count stays the same.
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * The GraphQL queries that one run of boo sends at the same time. GitHub counts the points of each
 * minute and the concurrent requests of a token in its secondary rate limits. The agents that use
 * the same token share these limits.
 */
export const GRAPHQL_CONCURRENCY = 4;
const graphqlSlot = concurrencyLimit(GRAPHQL_CONCURRENCY);

let accountCache: Promise<DiskCache | undefined> | undefined;

/**
 * The cache of the account of `gh`. Two accounts on one machine (a person and a GitHub App, for
 * example) can read different repositories, so each account has its own folder, named by a hash of its
 * token. With no token, the runs share nothing.
 */
function cacheOfAccount(): Promise<DiskCache | undefined> {
  accountCache ??= (async () => {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || (await gh(['auth', 'token']).catch(() => ''));
    if (!token.trim()) return undefined;
    const account = createHash('sha256').update(token.trim()).digest('hex').slice(0, 16);
    return new DiskCache(join(cacheDir(), account));
  })();
  return accountCache;
}

const cache = {
  get: async <T>(key: string, maxAgeMs: number, now?: number) => (await cacheOfAccount())?.get<T>(key, maxAgeMs, now),
  set: async (key: string, value: unknown, now?: number) => (await cacheOfAccount())?.set(key, value, now),
};
const RATE_KEY = 'graphql-rate-limit';
// GitHub gives a new count at each query. A count older than its reset time is a full count again.
const RATE_MAX_AGE_MS = 60 * 60_000;

/** Returns the last GraphQL points that a run of boo on this machine read, if their reset time is not past. */
export async function readRateLimit(now = new Date()): Promise<RateLimit | undefined> {
  const stored = await cache.get<RateLimit>(RATE_KEY, RATE_MAX_AGE_MS, now.getTime());
  return stored && new Date(stored.value.resetAt) > now ? stored.value : undefined;
}

// GitHub asks to wait at least one minute after a secondary rate limit.
const SECONDARY_WAIT_MS = 60_000;

/**
 * Records that the queries fail until the returned time, so that no run of boo on this machine sends
 * one before. If points remain, the limit is a secondary limit, which stops for one minute.
 */
async function recordRefusal(now = Date.now()): Promise<{ until?: string; secondary: boolean }> {
  try {
    // The REST endpoint of the rate limits costs no point, so it answers when GraphQL refuses.
    const { limit, remaining, reset } = JSON.parse(await gh(['api', 'rate_limit', '--jq', '.resources.graphql'])) as {
      limit: number;
      remaining: number;
      reset: number;
    };
    const until = remaining < POINTS_FLOOR ? reset * 1000 : now + SECONDARY_WAIT_MS;
    const rate = { limit, remaining: Math.min(remaining, POINTS_FLOOR - 1), resetAt: new Date(until).toISOString() };
    await cache.set(RATE_KEY, rate);
    return { until: rate.resetAt, secondary: remaining >= POINTS_FLOOR };
  } catch {
    // With no reset time, wait as for a secondary limit: else each poll sends a query that fails.
    await cache.set(RATE_KEY, { limit: 0, remaining: 0, resetAt: new Date(now + SECONDARY_WAIT_MS).toISOString() });
    return { secondary: false };
  }
}

interface Response<T> {
  data?: (T & { rateLimit?: RateLimit }) | null;
  errors?: { message: string }[];
}

/**
 * Sends a GraphQL query and records the points that remain. With `partial`, a response with errors
 * gives the data that GitHub could read: for example, a probe of a pull request that is gone.
 */
async function query<T>(text: string, variables: Variables = {}, partial = false): Promise<T | undefined> {
  const args = Object.entries(variables).flatMap(([key, value]) => [
    typeof value === 'number' ? '-F' : '-f',
    `${key}=${value}`,
  ]);
  const output = await graphqlSlot(async () => {
    // A query that waits for a slot can start after another query met a refusal.
    const refusedUntil = pointsOutUntil(await readRateLimit());
    if (refusedUntil) throw new QuotaError(quotaMessage(refusedUntil), refusedUntil);
    // gh exits with an error if the response has errors, but it writes the response on stdout.
    return gh(['api', 'graphql', ...args, '-f', `query=${text}`]).catch(async (error: Error & { stdout?: string }) => {
      if (isRateLimited(error.message)) {
        const { until, secondary } = await recordRefusal();
        throw new QuotaError(quotaMessage(until, secondary), until);
      }
      if (partial && error.stdout) return error.stdout;
      throw error;
    });
  });
  const response = JSON.parse(output) as Response<T>;
  if (response.data?.rateLimit) await cache.set(RATE_KEY, response.data.rateLimit);
  if (response.errors?.length && !partial)
    throw new Error(`GitHub GraphQL: ${response.errors.map((error) => error.message).join('; ')}`);
  return response.data ?? undefined;
}

const POST_CLAIM_MS = 2 * 60_000;

/**
 * Returns true if this run may post `what` on the pull request now. Two runs of boo that read the same
 * pull request at the same time would both post: only the first that claims the post does.
 */
export async function claimPost(pr: PullRequest, what: string): Promise<boolean> {
  const cache = await cacheOfAccount();
  return cache ? cache.claim(postKey(pr, what), POST_CLAIM_MS) : true;
}

/** Gives back the claim of a post that failed, so that a run can try it again at once. */
export async function releasePost(pr: PullRequest, what: string): Promise<void> {
  await (await cacheOfAccount())?.release(postKey(pr, what));
}

/** The time that a run waits for the post of another run that holds the claim. */
export const POST_WAIT_MS = POST_CLAIM_MS;

const postKey = (pr: PullRequest, what: string) => `post-${pr.repo}#${pr.number}-${what}`;

/**
 * The age of a cached pull request that a read takes. It is the poll interval of the watch: a watch
 * never reads its own last read again, but a second run within this time reads no GitHub.
 */
export const CACHE_TTL_MS = 30_000;

/**
 * Reads a pull request. A read by another run of boo, younger than `maxAgeMs`, answers with no query.
 * Pass 0 to read GitHub, for example after a post that waits for a reply.
 */
export async function fetchPullRequest(
  pr: PullRequest,
  { maxAgeMs = CACHE_TTL_MS, extra = {} }: { maxAgeMs?: number; extra?: ExtraFields } = {},
): Promise<PullRequestSnapshot> {
  const key = readKey(pr, extra);
  if (maxAgeMs > 0) {
    const unchanged = await unchangedRead(cache, key, probes.get(probeKey(pr)), maxAgeMs);
    if (unchanged) return unchanged;
  }
  return readOrLast(cache, key, maxAgeMs, async () => {
    const until = pointsOutUntil(await readRateLimit());
    if (until) throw new QuotaError(quotaMessage(until), until);
    return readPullRequest(pr, extra);
  });
}

/**
 * Reads with `cachedRead`. If `read` fails with a `QuotaError`, returns the last cached value of any
 * age, marked `stale`. With no cached value, the error stays.
 */
export async function readOrLast(
  store: ReadCache,
  key: string,
  maxAgeMs: number,
  read: () => Promise<PullRequestSnapshot>,
): Promise<PullRequestSnapshot> {
  try {
    return await cachedRead(store, key, maxAgeMs, read);
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error;
    const last = await store.get<PullRequestSnapshot>(key, Infinity);
    if (!last) throw error;
    return {
      ...last.value,
      stale: { at: new Date(last.at).toISOString(), ...(error.until && { until: error.until }) },
    };
  }
}

/** The time after which a read of a pull request that the probe finds unchanged reads all again. */
export const UNCHANGED_MAX_AGE_MS = 5 * 60_000;

/**
 * Returns the cached read if a probe younger than `maxAgeMs` gives the same fingerprint, and the read
 * is younger than `UNCHANGED_MAX_AGE_MS`. The cache keeps the time of the read, so the read gets older.
 */
export async function unchangedRead(
  store: ReadCache,
  key: string,
  probe: { fingerprint: string; at: number } | undefined,
  maxAgeMs: number,
  now = Date.now(),
): Promise<PullRequestSnapshot | undefined> {
  if (!probe || now - probe.at >= maxAgeMs) return undefined;
  const last = await store.get<PullRequestSnapshot>(key, UNCHANGED_MAX_AGE_MS, now);
  return last?.value.fingerprint === probe.fingerprint ? last.value : undefined;
}

const probes = new Map<string, { fingerprint: string; at: number }>();
const probeKey = (pr: PullRequest) => `${pr.repo}#${pr.number}`;

// About 6 connections for each pull request: 50 pull requests cost 3 points.
const PROBE_BATCH = 50;

/**
 * Reads the probe fields of the pull requests, with one query for each 50. A later
 * `fetchPullRequest` then reads only the pull requests that changed. A probe that fails changes
 * nothing: each read reads all.
 */
export async function probePullRequests(prs: readonly PullRequest[]): Promise<void> {
  if (prs.length === 0 || pointsOutUntil(await readRateLimit())) return;
  const batches = Array.from({ length: Math.ceil(prs.length / PROBE_BATCH) }, (_, index) =>
    prs.slice(index * PROBE_BATCH, (index + 1) * PROBE_BATCH),
  );
  await Promise.all(
    batches.map(async (batch) => {
      const at = Date.now();
      const data = await query<Record<string, { pullRequest: Record<string, unknown> | null } | null>>(
        probeQuery(batch),
        {},
        true,
      ).catch(() => undefined);
      batch.forEach((pr, index) => {
        const node = data?.[`p${index}`]?.pullRequest;
        if (node) probes.set(probeKey(pr), { fingerprint: fingerprintOf(node), at });
        else probes.delete(probeKey(pr));
      });
    }),
  );
}

/** The cache key of a read. A read with fewer fields must not answer a read that needs the threads or the files. */
export const readKey = (pr: PullRequest, { threads, files, lineComments, reviewerChecks }: ExtraFields) =>
  `pr-${pr.repo}#${pr.number}${threads ? '+threads' : ''}${files ? '+files' : ''}${lineComments ? '+lines' : ''}${
    reviewerChecks?.length ? `+errors:${reviewerChecks.join(',')}` : ''
  }`;

/**
 * The error line of the log of a GitHub Actions job. The last "##[error]" annotation wins: an action
 * writes its cause there when it fails, and an earlier one can be an error that a step caught. With no
 * annotation, the first line that starts with "fatal" or "error". The annotation "Process completed
 * with exit code 1" tells nothing.
 */
export function firstErrorLine(log: string): string | undefined {
  let annotation: string | undefined;
  let plain: string | undefined;
  for (const raw of log.split('\n')) {
    const line = raw.replace(/^\d{4}-\d{2}-\d{2}T\S+Z /, '').trim();
    if (/^##\[error\]Process completed with exit code/.test(line)) continue;
    if (line.startsWith('##[error]')) annotation = line.slice('##[error]'.length).trim() || annotation;
    else if (!plain && /^(?:fatal|error)\b\W/i.test(line)) plain = line;
  }
  const text = annotation ?? plain;
  return text && text.length > ERROR_LENGTH ? `${text.slice(0, ERROR_LENGTH - 1)}…` : text;
}

const ERROR_LENGTH = 200;

/** A read of a log that takes longer fails: the read of the pull request waits for it. */
export const JOB_LOG_TIMEOUT_MS = 10_000;

/** A log that GitHub did not give is read again after this time: it can come some seconds after the end of the job. */
export const JOB_LOG_RETRY_MS = 5 * 60_000;

/**
 * Reads the first error line of a finished job. A log that GitHub gave does not change, so its line
 * stays in the cache for ever. A failed read stays only `JOB_LOG_RETRY_MS`: a rate limit, a network
 * error or a log that is not ready yet must not hide the line for ever.
 */
export async function jobErrorLine(
  store: ReadCache,
  key: string,
  readLog: () => Promise<string>,
  now = Date.now(),
  timeoutMs = JOB_LOG_TIMEOUT_MS,
): Promise<string | undefined> {
  const known = await store.get<{ line: string | null; failed?: true }>(key, Infinity, now);
  if (known && (!known.value.failed || now - known.at < JOB_LOG_RETRY_MS)) return known.value.line ?? undefined;
  try {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the log read timed out')), timeoutMs);
    });
    const line = firstErrorLine(await Promise.race([readLog(), late]).finally(() => clearTimeout(timer)));
    await store.set(key, { line: line ?? null });
    return line;
  } catch {
    await store.set(key, { line: null, failed: true });
    return undefined;
  }
}

const jobError = (repo: string, job: number) =>
  jobErrorLine(cache, `job-error-${repo}-${job}`, () =>
    gh(['api', `repos/${repo}/actions/jobs/${job}/logs`], { timeout: JOB_LOG_TIMEOUT_MS }),
  );

/** Adds the first error line to each failed check of a review bot that is a GitHub Actions job. */
async function withReviewerErrors(repo: string, checks: Check[], names: readonly string[] = []): Promise<Check[]> {
  const listed = (name: string) => names.some((other) => other.toLowerCase() === name.toLowerCase());
  return Promise.all(
    checks.map(async (check) => {
      if (check.state !== 'failure' || check.cancelled || !check.workflow || !check.id || !listed(check.name))
        return check;
      const error = await jobError(repo, check.id);
      return error ? { ...check, error } : check;
    }),
  );
}

async function readPullRequest(pr: PullRequest, extra: ExtraFields): Promise<PullRequestSnapshot> {
  const { snapshot, node } = await readPullRequestWith((text, variables) => query(text, variables), pr, extra);
  return {
    ...snapshot,
    checks: await withReviewerErrors(pr.repo, snapshot.checks, extra.reviewerChecks),
    fingerprint: fingerprintOf(node),
  };
}

/**
 * Sends a request to a bot. A bot with a reviewer gets a review request from GitHub, and the function
 * returns the URL of the pull request. Another bot gets a comment, and the function returns its URL.
 */
export async function requestReview(pr: PullRequest, request: Request): Promise<string> {
  const { reviewer } = request.bot;
  if (reviewer) {
    await gh(['pr', 'edit', String(pr.number), '--repo', pr.repo, '--add-reviewer', reviewer]);
    return pr.url;
  }
  const url = await gh(['pr', 'comment', String(pr.number), '--repo', pr.repo, '--body', requestText(request)]);
  return url.trim();
}

/**
 * Merges the pull request with the first method that the repository allows: squash, merge, then rebase.
 * The repository settings decide if GitHub deletes the branch.
 * GitHub refuses the merge if the pull request has a newer head than the one that the user confirmed.
 */
export async function mergePullRequest(pr: PullRequest, head: string): Promise<void> {
  const allowed = JSON.parse(
    await gh([
      'api',
      `repos/${pr.repo}`,
      '--jq',
      '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}',
    ]),
  ) as Record<'squash' | 'merge' | 'rebase', boolean>;
  const method = (['squash', 'merge', 'rebase'] as const).find((candidate) => allowed[candidate]);
  if (!method) throw new Error(`${pr.repo} allows no merge method`);
  await gh(['pr', 'merge', String(pr.number), '--repo', pr.repo, `--${method}`, '--match-head-commit', head]);
}

let viewer: Promise<string | undefined> | undefined;

/** Returns the login of the account of `gh`, read once. Undefined if GitHub does not give it. */
export function viewerLogin(): Promise<string | undefined> {
  viewer ??= gh(['api', 'graphql', '-f', 'query={ viewer { login } }', '--jq', '.data.viewer.login'])
    .then((login) => login.trim() || undefined)
    .catch(() => {
      // A rate limit at the start must not hide the viewer for the whole watch.
      viewer = undefined;
      return undefined;
    });
  return viewer;
}

const OPENERS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'open', win32: 'explorer' };

export function openInBrowser(url: string): Promise<void> {
  const opener = OPENERS[process.platform] ?? 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Reads a pull request named as "owner/repo#123", "repo#123" in the organization, or its URL. Returns
 * undefined if the text names no pull request.
 */
export function parsePullRequestRef(text: string, org: string): PullRequest | undefined {
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(text.trim());
  const short = /^((?:[\w.-]+\/)?[\w.-]+)#(\d+)$/.exec(text.trim());
  const match = url ?? short;
  if (!match) return undefined;
  // "." and ".." name no repository: GitHub would refuse the read with an error that tells less.
  if (match[1]!.split('/').some((part) => part === '.' || part === '..')) return undefined;
  if (!match[1]!.includes('/') && !org) return undefined;
  const repo = match[1]!.includes('/') ? match[1]! : `${org}/${match[1]}`;
  const number = Number(match[2]);
  return { repo, number, title: '', url: `https://github.com/${repo}/pull/${number}` };
}

/** Keeps one of each pull request: a pull request named twice gives one object. */
export const uniqueRefs = (refs: readonly PullRequest[]): PullRequest[] => [
  ...new Map(refs.map((ref) => [`${ref.repo}#${ref.number}`, ref])).values(),
];
