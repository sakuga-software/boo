import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { requestText, type Request } from './actions.js';
import { detectAgent, type Agent } from './agents.js';
import { cachedRead, cacheDir, DiskCache, type ReadCache } from './cache.js';
import type { Comment, Review } from './decide.js';
import type { OpenThread } from './policy.js';
import { isBotLogin, type Check, type CheckState } from './reviewers.js';

const execFileAsync = promisify(execFile);

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const { stderr, stdout } = error as { stderr?: string; stdout?: string };
    throw Object.assign(new Error(stderr?.trim() || (error as Error).message), { stdout });
  }
}

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
}

export interface SearchOptions {
  org: string;
  authors: string[];
  /** The full names of the repositories to watch. Empty or undefined: every repository of the organization. */
  repos?: string[];
  since?: string;
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
      const until = await recordRefusal();
      throw new QuotaError(quotaMessage(until), until);
    }
  });
}

/** The cache key of a list. Two runs with the same options share their list. */
export const listKey = ({ org, authors, repos = [], since }: SearchOptions) =>
  `list-${createHash('sha256')
    .update(JSON.stringify([org, [...authors].sort(), [...repos].sort(), since ?? '']))
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
async function searchAll({ org, authors, repos = [], since }: SearchOptions): Promise<PullRequest[]> {
  const searches = await Promise.all(
    authors.map((author) => searchPullRequests({ org, author, repos, ...(since && { since }) })),
  );
  return mergeSearches(searches).map((result) => ({
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

export function mergeSearches<T extends Pick<SearchResult, 'url' | 'isDraft' | 'updatedAt'>>(searches: T[][]): T[] {
  const byUrl = new Map(searches.flat().map((result) => [result.url, result]));
  return [...byUrl.values()].filter((result) => !result.isDraft).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

export type PullRequestStatus = 'open' | 'draft' | 'merged' | 'closed';

export interface PullRequestSnapshot {
  status: PullRequestStatus;
  head: string;
  /** The head branch. */
  branch: string;
  /** True if the head branch is in a fork. */
  fork: boolean;
  /** The branch that the pull request merges into. */
  base: string;
  defaultBranch: string;
  author: string;
  /** The GitHub mergeable state in lower case: clean, dirty, blocked, unstable, behind, unknown… */
  mergeState: string;
  reviews: Review[];
  comments: Comment[];
  checks: Check[];
  /** The checks of the last commit of the base branch: the first 100. */
  baseChecks?: Check[];
  /** The logins that GitHub still asks for a review. */
  requested: string[];
  /** The coding agent that the pull request names. */
  agent?: Agent;
  /** The description of the pull request. */
  body?: string;
  /** The review threads that are not resolved. Undefined if the query did not read the threads. */
  openThreads?: OpenThread[];
  /** The changed files. Undefined if the query did not read them. */
  files?: string[];
  /** The commit time of the head commit. A rebase or an amend gives a new time. */
  headAt?: string;
  /** The size of the change. */
  changes?: { additions: number; deletions: number; files: number };
  /** The login that merged the pull request. Undefined if it is not merged, or if GitHub does not give the account. */
  mergedBy?: string;
  mergedAt?: string;
  /**
   * GitHub moved the pull request to a new base after its base branch was deleted, and no commit came
   * after that. A squash merge of the parent leaves its commits in this pull request: it needs a rebase.
   */
  restack?: { oldBase: string; at: string };
  /**
   * GitHub refuses the GraphQL queries for a rate limit, so this is the last read that worked, at `at`.
   * `until` is the time that the queries work again, if GitHub tells it.
   */
  stale?: { at: string; until?: string };
  /** A hash of the fields that `probePullRequests` reads, at the time of the read. */
  fingerprint?: string;
}

const reviewFields = (lineComments?: boolean) =>
  `author { login __typename } state submittedAt body commit { oid } comments(first: 10) { totalCount nodes { replyTo { id }${lineComments ? ' databaseId body createdAt' : ''} } }`;
const COMMENT_FIELDS = 'databaseId author { login __typename } body createdAt updatedAt';
const CONTEXT_FIELDS =
  '__typename ... on CheckRun { name status conclusion checkSuite { workflowRun { databaseId workflow { name } } } } ... on StatusContext { context state description }';
const OLDER = 'pageInfo { hasPreviousPage startCursor }';
const NEWER = 'pageInfo { hasNextPage endCursor }';
const PULL = 'repository(owner: $owner, name: $name) { pullRequest(number: $number)';
const VARIABLES = '$owner: String!, $name: String!, $number: Int!';

// The first query reads the newest reviews and comments, and the first checks. A long pull request
// needs more pages: the decisions depend on old verdicts and on the first CodeRabbit comment.
/** The parts of a pull request that only a merge policy or the events read. Each one costs GraphQL points or bytes. */
export interface ExtraFields {
  /** The authors of the review threads that are not resolved: the first 100 threads. */
  threads?: boolean;
  /** The changed files: the first 100. */
  files?: boolean;
  /** The text of the line comments: the first 10 of each review. */
  lineComments?: boolean;
}

// The probe reads only the fields that change when the pull request changes. Known misses: a
// review thread that somebody resolves, and the checks of the base branch. A read older than
// UNCHANGED_MAX_AGE_MS reads all again, so these misses last at most that time.
const PROBE_FRAGMENT = `fragment Probe on PullRequest {
  updatedAt headRefOid mergeStateStatus state isDraft
  probeFirstComment: comments(first: 1) { nodes { updatedAt } }
  probeLastComment: comments(last: 1) { nodes { updatedAt } }
  probeLastReview: reviews(last: 1) { nodes { updatedAt } }
  probeHead: commits(last: 1) { nodes { commit { checkSuites(first: 1) { totalCount } statusCheckRollup { state
    contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }
  probeBase: baseRef { target { oid } }
}`;
const PROBE_KEYS = [
  'updatedAt',
  'headRefOid',
  'mergeStateStatus',
  'state',
  'isDraft',
  'probeFirstComment',
  'probeLastComment',
  'probeLastReview',
  'probeHead',
  'probeBase',
] as const;

export const fingerprintOf = (node: Record<string, unknown>) =>
  createHash('sha256')
    .update(JSON.stringify(PROBE_KEYS.map((key) => node[key] ?? null)))
    .digest('hex')
    .slice(0, 16);

const queryOf = ({ threads, files, lineComments }: ExtraFields) => `${PROBE_FRAGMENT}
query(${VARIABLES}) {
  rateLimit { limit remaining resetAt }
  ${PULL} {
    ...Probe
    state isDraft merged mergedAt mergedBy { login __typename } mergeStateStatus headRefOid headRefName baseRefName isCrossRepository body
    additions deletions changedFiles
    timelineItems(itemTypes: [AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_COMMIT], last: 1) {
      nodes { __typename ... on AutomaticBaseChangeSucceededEvent { oldBase createdAt } } }
    baseRepository { defaultBranchRef { name } }
    baseRef { target { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { ${CONTEXT_FIELDS} } } } } } }
    author { login __typename }
    reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } }
    reviews(last: 100) { ${OLDER} nodes { ${reviewFields(lineComments)} } }
    comments(last: 100) { ${OLDER} nodes { ${COMMENT_FIELDS} } }
    commits(last: 1) { nodes { commit { message committedDate authors(first: 10) { nodes { user { login } } }
      checkSuites(first: 100) { nodes { status workflowRun { databaseId workflow { name } } } }
      statusCheckRollup { contexts(first: 100) { ${NEWER} nodes { ${CONTEXT_FIELDS} } } } } } }
    ${threads ? 'reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login __typename } } } latest: comments(last: 1) { nodes { author { login __typename } body } } } }' : ''}
    ${files ? 'files(first: 100) { nodes { path } }' : ''}
  } }
}`;

const reviewsPage = (lineComments?: boolean) =>
  `query(${VARIABLES}, $cursor: String!) { ${PULL} { page: reviews(last: 100, before: $cursor) { ${OLDER} nodes { ${reviewFields(lineComments)} } } } } }`;

const PAGE_QUERIES = {
  comments: `query(${VARIABLES}, $cursor: String!) { ${PULL} { page: comments(last: 100, before: $cursor) { ${OLDER} nodes { ${COMMENT_FIELDS} } } } } }`,
  contexts: `query(${VARIABLES}, $cursor: String!) { ${PULL} { commits(last: 1) { nodes { commit { statusCheckRollup {
    page: contexts(first: 100, after: $cursor) { ${NEWER} nodes { ${CONTEXT_FIELDS} } } } } } } } } }`,
};

interface Actor {
  login: string;
  __typename: string;
}

interface CommentNode {
  databaseId: number;
  author: Actor | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface ReviewNode {
  author: Actor | null;
  state: string;
  submittedAt: string | null;
  body: string;
  commit: { oid: string } | null;
  comments: {
    totalCount: number;
    nodes: { replyTo: { id: string } | null; databaseId?: number; body?: string; createdAt?: string }[];
  };
}

interface PageInfo {
  hasPreviousPage?: boolean;
  startCursor?: string | null;
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface Page<T> {
  pageInfo?: PageInfo;
  nodes: T[];
}

type ContextNode =
  | {
      __typename: 'CheckRun';
      name: string;
      status: string;
      conclusion: string | null;
      checkSuite?: { workflowRun: { databaseId: number; workflow: { name: string } } | null } | null;
    }
  | { __typename: 'StatusContext'; context: string; state: string; description: string | null };

interface PullRequestNode {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  merged: boolean;
  mergedAt?: string | null;
  mergedBy?: Actor | null;
  mergeStateStatus: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  body: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  timelineItems?: { nodes: { __typename: string; oldBase?: string; createdAt?: string }[] };
  baseRepository: { defaultBranchRef: { name: string } | null } | null;
  baseRef?: { target: { statusCheckRollup?: { contexts: Page<ContextNode> } | null } | null } | null;
  author: Actor | null;
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[] };
  reviews: Page<ReviewNode>;
  comments: Page<CommentNode>;
  reviewThreads?: {
    nodes: {
      isResolved: boolean;
      comments: { nodes: { author: Actor | null }[] };
      latest?: { nodes: { author: Actor | null; body: string }[] };
    }[];
  };
  files?: { nodes: { path: string }[] };
  commits: {
    nodes: {
      commit: {
        message?: string;
        committedDate?: string;
        authors?: { nodes: { user: { login: string } | null }[] };
        checkSuites?: { nodes: SuiteNode[] } | null;
        statusCheckRollup: { contexts: Page<ContextNode> } | null;
      };
    }[];
  };
}

/** GraphQL drops the "[bot]" suffix of a bot login. The REST API and the decision rules keep it. */
export function loginOf(actor: Actor | null): string | null {
  if (!actor) return null;
  return actor.__typename === 'Bot' ? `${actor.login}[bot]` : actor.login;
}

const userOf = (actor: Actor | null) => {
  const login = loginOf(actor);
  return login ? { login } : null;
};

function toComment(node: CommentNode): Comment {
  return {
    id: node.databaseId,
    user: userOf(node.author),
    body: node.body,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

// A reply in a review thread makes GitHub add a review whose line comments all answer an earlier comment.
// A review with an empty body can be a real review: Greptile puts all its findings on the lines.
function toReview(node: ReviewNode): Review | null {
  if (!node.submittedAt || !node.commit) return null;
  // The query reads 10 line comments of each review. A review with more is not a reply, so a real review is never lost.
  const comments = node.comments.nodes;
  const threadReply =
    node.body === '' &&
    comments.length > 0 &&
    node.comments.totalCount <= comments.length &&
    comments.every((comment) => comment.replyTo !== null);
  return {
    user: userOf(node.author),
    commit_id: node.commit.oid,
    submitted_at: node.submittedAt,
    state: node.state,
    body: node.body,
    threadReply,
    ...(comments.some((comment) => comment.body !== undefined) && {
      lineComments: comments.map((comment) => ({
        id: comment.databaseId ?? 0,
        body: comment.body ?? '',
        created_at: comment.createdAt ?? node.submittedAt!,
      })),
    }),
  };
}

function checkState(node: ContextNode): CheckState {
  if (node.__typename === 'StatusContext') {
    if (node.state === 'PENDING' || node.state === 'EXPECTED') return 'pending';
    return node.state === 'SUCCESS' ? 'success' : 'failure';
  }
  if (node.status !== 'COMPLETED') return 'pending';
  if (node.conclusion === 'SUCCESS' || node.conclusion === 'NEUTRAL') return 'success';
  return node.conclusion === 'SKIPPED' ? 'skipped' : 'failure';
}

function toCheck(node: ContextNode): Check {
  if (node.__typename === 'StatusContext') {
    return { name: node.context, state: checkState(node), ...(node.description && { description: node.description }) };
  }
  const run = node.checkSuite?.workflowRun;
  return {
    name: node.name,
    state: checkState(node),
    ...(run && { workflow: run.workflow.name, run: run.databaseId }),
    ...(node.conclusion === 'CANCELLED' && { cancelled: true }),
  };
}

interface SuiteNode {
  status: string;
  workflowRun: { databaseId: number; workflow: { name: string } } | null;
}

/**
 * Adds one running check for each workflow whose last run on the commit has no running check yet. A
 * queued run has no check run, so the rollup lists only the workflows that started. A run that is
 * between two jobs can also have only finished checks. The suites of the apps that are not GitHub
 * Actions have no workflow run: many stay QUEUED for ever, so they do not count.
 */
export function withUnfinishedRuns(checks: Check[], suites: readonly SuiteNode[]): Check[] {
  const lastRuns = new Map<string, { run: number; status: string }>();
  for (const { status, workflowRun } of suites) {
    if (!workflowRun) continue;
    const known = lastRuns.get(workflowRun.workflow.name);
    if (!known || known.run < workflowRun.databaseId)
      lastRuns.set(workflowRun.workflow.name, { run: workflowRun.databaseId, status });
  }
  const unfinished = [...lastRuns].filter(
    ([, { run, status }]) =>
      status !== 'COMPLETED' && !checks.some((check) => check.run === run && check.state === 'pending'),
  );
  return [
    ...checks,
    ...unfinished.map(([workflow, { run }]): Check => ({
      name: workflow,
      state: 'pending',
      workflow,
      run,
      wholeRun: true,
    })),
  ];
}

function restackOf(pull: PullRequestNode): { restack?: { oldBase: string; at: string } } {
  const last = pull.timelineItems?.nodes.at(-1);
  if (last?.__typename !== 'AutomaticBaseChangeSucceededEvent' || !last.oldBase || !last.createdAt) return {};
  return { restack: { oldBase: last.oldBase, at: last.createdAt } };
}

function statusOf(pull: PullRequestNode): PullRequestStatus {
  if (pull.merged || pull.state === 'MERGED') return 'merged';
  if (pull.state === 'CLOSED') return 'closed';
  return pull.isDraft ? 'draft' : 'open';
}

export function toSnapshot(pull: PullRequestNode): PullRequestSnapshot {
  const commit = pull.commits.nodes[0]?.commit;
  const agent = detectAgent({
    author: loginOf(pull.author) ?? '',
    branch: pull.headRefName,
    body: pull.body,
    commitMessage: commit?.message ?? '',
    commitAuthors: (commit?.authors?.nodes ?? []).flatMap(({ user }) => (user ? [user.login] : [])),
  });
  return {
    status: statusOf(pull),
    head: pull.headRefOid,
    branch: pull.headRefName,
    fork: pull.isCrossRepository,
    base: pull.baseRefName,
    defaultBranch: pull.baseRepository?.defaultBranchRef?.name ?? pull.baseRefName,
    author: loginOf(pull.author) ?? '',
    mergeState: pull.mergeStateStatus.toLowerCase(),
    reviews: pull.reviews.nodes.map(toReview).filter((review) => review !== null),
    comments: pull.comments.nodes.map(toComment),
    checks: withUnfinishedRuns(
      (commit?.statusCheckRollup?.contexts.nodes ?? []).map(toCheck),
      commit?.checkSuites?.nodes ?? [],
    ),
    baseChecks: (pull.baseRef?.target?.statusCheckRollup?.contexts.nodes ?? []).map(toCheck),
    requested: pull.reviewRequests.nodes
      .map(({ requestedReviewer: reviewer }) =>
        reviewer?.__typename === 'Team'
          ? reviewer.slug
          : reviewer?.login && loginOf({ login: reviewer.login, __typename: reviewer.__typename }),
      )
      .filter((login): login is string => Boolean(login)),
    ...(agent && { agent }),
    body: pull.body,
    ...(pull.reviewThreads && {
      openThreads: pull.reviewThreads.nodes
        .filter((thread) => !thread.isResolved)
        .map((thread): OpenThread => {
          const last = thread.latest?.nodes.at(-1);
          const lastBotComment = last && isBotLogin(loginOf(last.author) ?? '') ? last.body : undefined;
          return {
            author: loginOf(thread.comments.nodes[0]?.author ?? null) ?? '',
            ...(lastBotComment !== undefined && { lastBotComment }),
          };
        }),
    }),
    ...(pull.files && { files: pull.files.nodes.map((file) => file.path) }),
    ...(commit?.committedDate && { headAt: commit.committedDate }),
    ...restackOf(pull),
    ...(pull.changedFiles !== undefined && {
      changes: { additions: pull.additions ?? 0, deletions: pull.deletions ?? 0, files: pull.changedFiles },
    }),
    ...(pull.mergedBy && { mergedBy: loginOf(pull.mergedBy)! }),
    ...(pull.mergedAt && { mergedAt: pull.mergedAt }),
  };
}

type Variables = Record<string, string | number>;

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

const quotaMessage = (until: string | undefined, secondary = false) =>
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
  set: async (key: string, value: unknown) => (await cacheOfAccount())?.set(key, value),
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

async function graphql(text: string, variables: Variables): Promise<PullRequestNode> {
  const data = await query<{ repository: { pullRequest: PullRequestNode | null } | null }>(text, variables);
  const pull = data?.repository?.pullRequest;
  if (!pull)
    throw new Error(
      `${variables.owner}/${variables.name}#${variables.number} is not readable: no such pull request, or no access`,
    );
  return pull;
}

/** Reads the other pages of a connection, older pages first or newer pages last, and returns all its nodes. */
async function allNodes<T>(
  first: Page<T>,
  direction: 'older' | 'newer',
  query: string,
  variables: Variables,
  pageOf: (pull: PullRequestNode) => Page<T> | undefined,
): Promise<T[]> {
  let nodes = first.nodes;
  let info = first.pageInfo;
  const seen = new Set<string>();
  while (true) {
    const cursor =
      direction === 'older' ? info?.hasPreviousPage && info.startCursor : info?.hasNextPage && info.endCursor;
    if (!cursor) return nodes;
    if (seen.has(cursor))
      throw new Error(
        `GitHub GraphQL gave the same page cursor twice for ${variables.owner}/${variables.name}#${variables.number}`,
      );
    seen.add(cursor);
    const page = pageOf(await graphql(query, { ...variables, cursor }));
    if (!page || page.nodes.length === 0) return nodes;
    nodes = direction === 'older' ? [...page.nodes, ...nodes] : [...nodes, ...page.nodes];
    info = page.pageInfo;
  }
}

// A post appears on GitHub within seconds. After this time, a fresh read of the other run sees it.
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

/** The query that reads the probe fields of several pull requests, one alias for each. */
export const probeQuery = (prs: readonly PullRequest[]) => {
  const aliases = prs.map((pr, index) => {
    const [owner = '', name = ''] = pr.repo.split('/');
    return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${pr.number}) { ...Probe } }`;
  });
  return `${PROBE_FRAGMENT}\nquery { rateLimit { limit remaining resetAt }\n${aliases.join('\n')}\n}`;
};

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
export const readKey = (pr: PullRequest, { threads, files, lineComments }: ExtraFields) =>
  `pr-${pr.repo}#${pr.number}${threads ? '+threads' : ''}${files ? '+files' : ''}${lineComments ? '+lines' : ''}`;

async function readPullRequest(pr: PullRequest, extra: ExtraFields): Promise<PullRequestSnapshot> {
  const [owner = '', name = ''] = pr.repo.split('/');
  const variables = { owner, name, number: pr.number };
  const pull = await graphql(queryOf(extra), variables);
  type Pages = { page?: Page<never> };
  const page = (value: unknown) => (value as Pages).page;
  const rollup = pull.commits.nodes[0]?.commit.statusCheckRollup;
  const [reviews, comments, contexts] = await Promise.all([
    allNodes(pull.reviews, 'older', reviewsPage(extra.lineComments), variables, page),
    allNodes(pull.comments, 'older', PAGE_QUERIES.comments, variables, page),
    rollup
      ? allNodes(rollup.contexts, 'newer', PAGE_QUERIES.contexts, variables, (next) =>
          page(next.commits.nodes[0]?.commit.statusCheckRollup),
        )
      : Promise.resolve([]),
  ]);
  const snapshot = toSnapshot({
    ...pull,
    reviews: { nodes: reviews },
    comments: { nodes: comments },
    commits: {
      nodes: [
        {
          commit: {
            ...pull.commits.nodes[0]?.commit,
            statusCheckRollup: rollup ? { contexts: { nodes: contexts } } : null,
          },
        },
      ],
    },
  });
  return { ...snapshot, fingerprint: fingerprintOf(pull as unknown as Record<string, unknown>) };
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
