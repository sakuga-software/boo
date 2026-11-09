import { detectAgent, type Agent } from './agents.js';
import type { Comment, Review } from './decide.js';
import type { OpenThread } from './policy.js';
import { isBotLogin, type Check, type CheckState } from './reviewers.js';

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
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
  /** The title of the pull request, as the read gives it. */
  title?: string;
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
// The reactions cost no GraphQL point (measured on 100 comments): a review bot answers a request with 👀, or with 😕 when it fails.
const COMMENT_FIELDS =
  'databaseId author { login __typename } body createdAt updatedAt reactionGroups { content reactors(first: 50) { totalCount nodes { __typename ... on Bot { login } ... on User { login } } } }';
const CONTEXT_FIELDS =
  '__typename ... on CheckRun { databaseId name status conclusion checkSuite { workflowRun { databaseId workflow { name } } } } ... on StatusContext { context state description }';
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
  /** The names of the checks of the review bots. The read gives the first error line of each one that fails. */
  reviewerChecks?: readonly string[] | undefined;
}

// The probe reads only the fields that change when the pull request changes. Known misses: a
// review thread that somebody resolves, and the checks of the base branch. A read older than
// UNCHANGED_MAX_AGE_MS reads all again, so these misses last at most that time.
export const PROBE_FRAGMENT = `fragment Probe on PullRequest {
  updatedAt headRefOid mergeStateStatus state isDraft
  probeFirstComment: comments(first: 1) { nodes { updatedAt } }
  probeLastComment: comments(last: 1) { nodes { updatedAt } }
  probeLastReview: reviews(last: 1) { nodes { updatedAt } }
  probeHead: commits(last: 1) { nodes { commit { checkSuites(first: 1) { totalCount } statusCheckRollup { state
    contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }
  probeBase: baseRef { target { oid } }
}`;
/** The fields of the probe, in the order that `fingerprintOf` hashes them. */
export const PROBE_KEYS = [
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

export const queryOf = ({ threads, files, lineComments }: ExtraFields) => `${PROBE_FRAGMENT}
query(${VARIABLES}) {
  rateLimit { limit remaining resetAt }
  ${PULL} {
    ...Probe
    title state isDraft merged mergedAt mergedBy { login __typename } mergeStateStatus headRefOid headRefName baseRefName isCrossRepository body
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
    ${threads ? 'reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login __typename } body } } latest: comments(last: 1) { nodes { author { login __typename } body } } } }' : ''}
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
  reactionGroups?:
    | { content: string; reactors: { totalCount: number; nodes?: ({ __typename: string; login?: string } | null)[] } }[]
    | null;
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
      databaseId?: number;
      name: string;
      status: string;
      conclusion: string | null;
      checkSuite?: { workflowRun: { databaseId: number; workflow: { name: string } } | null } | null;
    }
  | { __typename: 'StatusContext'; context: string; state: string; description: string | null };

interface PullRequestNode {
  title?: string;
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
      comments: { nodes: { author: Actor | null; body?: string }[] };
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
    ...(node.reactionGroups && {
      reactions: node.reactionGroups
        .filter((group) => group.reactors.totalCount > 0)
        .map((group) => {
          const nodes = group.reactors.nodes ?? [];
          return {
            content: group.content,
            logins: nodes.flatMap((reactor) =>
              reactor?.login ? [loginOf({ login: reactor.login, __typename: reactor.__typename })!] : [],
            ),
            ...(group.reactors.totalCount > nodes.length && { more: true as const }),
          };
        }),
    }),
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
    ...(node.databaseId !== undefined && { id: node.databaseId }),
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
    ...(pull.title !== undefined && { title: pull.title }),
    ...(pull.reviewThreads && {
      openThreads: pull.reviewThreads.nodes
        .filter((thread) => !thread.isResolved)
        .map((thread): OpenThread => {
          const last = thread.latest?.nodes.at(-1);
          const lastBotComment = last && isBotLogin(loginOf(last.author) ?? '') ? last.body : undefined;
          const first = thread.comments.nodes[0];
          const lastAuthor = last && loginOf(last.author);
          return {
            author: loginOf(first?.author ?? null) ?? '',
            ...(lastBotComment !== undefined && { lastBotComment }),
            ...(first?.body !== undefined && { body: first.body }),
            ...(lastAuthor && { lastAuthor }),
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

export type Variables = Record<string, string | number>;

/**
 * Sends a GraphQL query to GitHub and gives its `data`. The CLI sends it with `gh`, the relay and the
 * app with `fetch`. It throws if GitHub answers with errors.
 */
export type Graphql = (query: string, variables: Variables) => Promise<unknown>;

/** The pull request of a query that reads `repository { pullRequest }`. */
async function pullOf(graphql: Graphql, text: string, variables: Variables): Promise<PullRequestNode> {
  const data = (await graphql(text, variables)) as
    | { repository?: { pullRequest: PullRequestNode | null } | null }
    | null
    | undefined;
  const pull = data?.repository?.pullRequest;
  if (!pull)
    throw new Error(
      `${variables.owner}/${variables.name}#${variables.number} is not readable: no such pull request, or no access`,
    );
  return pull;
}

/** Reads the other pages of a connection, older pages first or newer pages last, and returns all its nodes. */
async function allNodes<T>(
  graphql: Graphql,
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
    const page = pageOf(await pullOf(graphql, query, { ...variables, cursor }));
    if (!page || page.nodes.length === 0) return nodes;
    nodes = direction === 'older' ? [...page.nodes, ...nodes] : [...nodes, ...page.nodes];
    info = page.pageInfo;
  }
}

/** The query that reads the probe fields of several pull requests, one alias for each. */
export const probeQuery = (prs: readonly PullRequest[]) => {
  const aliases = prs.map((pr, index) => {
    const [owner = '', name = ''] = pr.repo.split('/');
    return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${pr.number}) { ...Probe } }`;
  });
  return `${PROBE_FRAGMENT}\nquery { rateLimit { limit remaining resetAt }\n${aliases.join('\n')}\n}`;
};

/**
 * Reads a pull request with all the pages of its reviews, comments and checks. Gives the snapshot,
 * and the first page of the query for `fingerprintOf`.
 */
export async function readPullRequestWith(
  graphql: Graphql,
  pr: PullRequest,
  extra: ExtraFields,
): Promise<{ snapshot: PullRequestSnapshot; node: Record<string, unknown> }> {
  const [owner = '', name = ''] = pr.repo.split('/');
  const variables = { owner, name, number: pr.number };
  const pull = await pullOf(graphql, queryOf(extra), variables);
  type Pages = { page?: Page<never> };
  const page = (value: unknown) => (value as Pages).page;
  const rollup = pull.commits.nodes[0]?.commit.statusCheckRollup;
  const [reviews, comments, contexts] = await Promise.all([
    allNodes(graphql, pull.reviews, 'older', reviewsPage(extra.lineComments), variables, page),
    allNodes(graphql, pull.comments, 'older', PAGE_QUERIES.comments, variables, page),
    rollup
      ? allNodes(graphql, rollup.contexts, 'newer', PAGE_QUERIES.contexts, variables, (next) =>
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
  return { snapshot, node: pull as unknown as Record<string, unknown> };
}
