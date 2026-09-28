import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { commandBody, type Command } from "./actions.js";
import type { Comment, Review } from "./decide.js";
import type { Check, CheckState } from "./reviewers.js";

const execFileAsync = promisify(execFile);

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error as Error).message);
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
  author: string;
  since?: string;
}

export async function listPullRequests({ org, author, since }: SearchOptions): Promise<PullRequest[]> {
  const output = await gh([
    "search", "prs",
    ...(org ? ["--owner", org] : []),
    "--author", author,
    "--state", "open",
    ...(since ? ["--created", `>=${since}`] : []),
    "--sort", "updated",
    // 1000 is the most results that the GitHub search gives.
    "--limit", "1000",
    "--json", "repository,number,title,url,isDraft",
  ]);
  const results = JSON.parse(output) as {
    repository: { nameWithOwner: string };
    number: number;
    title: string;
    url: string;
    isDraft: boolean;
  }[];
  return results
    .filter((result) => !result.isDraft)
    .map((result) => ({
      repo: result.repository.nameWithOwner,
      number: result.number,
      title: result.title,
      url: result.url,
    }));
}

export type PullRequestStatus = "open" | "draft" | "merged" | "closed";

export interface PullRequestSnapshot {
  status: PullRequestStatus;
  head: string;
  author: string;
  /** The GitHub mergeable state in lower case: clean, dirty, blocked, unstable, behind, unknown… */
  mergeState: string;
  reviews: Review[];
  comments: Comment[];
  checks: Check[];
  /** The logins that GitHub still asks for a review. */
  requested: string[];
}

const REVIEW_FIELDS = "author { login __typename } state submittedAt body commit { oid } comments(first: 10) { totalCount nodes { replyTo { id } } }";
const COMMENT_FIELDS = "databaseId author { login __typename } body createdAt updatedAt";
const CONTEXT_FIELDS = "__typename ... on CheckRun { name status conclusion } ... on StatusContext { context state description }";
const OLDER = "pageInfo { hasPreviousPage startCursor }";
const NEWER = "pageInfo { hasNextPage endCursor }";
const PULL = "repository(owner: $owner, name: $name) { pullRequest(number: $number)";
const VARIABLES = "$owner: String!, $name: String!, $number: Int!";

// The first query reads the newest reviews and comments, and the first checks. A long pull request
// needs more pages: the decisions depend on old verdicts and on the first CodeRabbit comment.
const QUERY = `
query(${VARIABLES}) {
  ${PULL} {
    state isDraft merged mergeStateStatus headRefOid
    author { login __typename }
    reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } }
    reviews(last: 100) { ${OLDER} nodes { ${REVIEW_FIELDS} } }
    comments(last: 100) { ${OLDER} nodes { ${COMMENT_FIELDS} } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { ${NEWER} nodes { ${CONTEXT_FIELDS} } } } } } }
  } }
}`;

const PAGE_QUERIES = {
  reviews: `query(${VARIABLES}, $cursor: String!) { ${PULL} { page: reviews(last: 100, before: $cursor) { ${OLDER} nodes { ${REVIEW_FIELDS} } } } } }`,
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
  comments: { totalCount: number; nodes: { replyTo: { id: string } | null }[] };
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
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
  | { __typename: "StatusContext"; context: string; state: string; description: string | null };

interface PullRequestNode {
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  merged: boolean;
  mergeStateStatus: string;
  headRefOid: string;
  author: Actor | null;
  reviewRequests: { nodes: { requestedReviewer: ({ __typename: string; login?: string; slug?: string }) | null }[] };
  reviews: Page<ReviewNode>;
  comments: Page<CommentNode>;
  commits: { nodes: { commit: { statusCheckRollup: { contexts: Page<ContextNode> } | null } }[] };
}

/** GraphQL drops the "[bot]" suffix of a bot login. The REST API and the decision rules keep it. */
export const loginOf = (actor: Actor | null) =>
  actor ? (actor.__typename === "Bot" ? `${actor.login}[bot]` : actor.login) : null;

const userOf = (actor: Actor | null) => {
  const login = loginOf(actor);
  return login ? { login } : null;
};

function toComment(node: CommentNode): Comment {
  return { id: node.databaseId, user: userOf(node.author), body: node.body, created_at: node.createdAt, updated_at: node.updatedAt };
}

// A reply in a review thread makes GitHub add a review whose line comments all answer an earlier comment.
// A review with an empty body can be a real review: Greptile puts all its findings on the lines.
function toReview(node: ReviewNode): Review | null {
  if (!node.submittedAt || !node.commit) return null;
  // The query reads 10 line comments of each review. A review with more is not a reply, so a real review is never lost.
  const comments = node.comments.nodes;
  const threadReply =
    node.body === "" && comments.length > 0 && node.comments.totalCount <= comments.length && comments.every((comment) => comment.replyTo !== null);
  return {
    user: userOf(node.author),
    commit_id: node.commit.oid,
    submitted_at: node.submittedAt,
    state: node.state,
    body: node.body,
    threadReply,
  };
}

function checkState(node: ContextNode): CheckState {
  if (node.__typename === "StatusContext") {
    if (node.state === "PENDING" || node.state === "EXPECTED") return "pending";
    return node.state === "SUCCESS" ? "success" : "failure";
  }
  if (node.status !== "COMPLETED") return "pending";
  if (node.conclusion === "SUCCESS" || node.conclusion === "NEUTRAL") return "success";
  return node.conclusion === "SKIPPED" ? "skipped" : "failure";
}

function toCheck(node: ContextNode): Check {
  if (node.__typename === "StatusContext") {
    return { name: node.context, state: checkState(node), ...(node.description && { description: node.description }) };
  }
  return { name: node.name, state: checkState(node) };
}

function statusOf(pull: PullRequestNode): PullRequestStatus {
  if (pull.merged || pull.state === "MERGED") return "merged";
  if (pull.state === "CLOSED") return "closed";
  return pull.isDraft ? "draft" : "open";
}

export function toSnapshot(pull: PullRequestNode): PullRequestSnapshot {
  return {
    status: statusOf(pull),
    head: pull.headRefOid,
    author: loginOf(pull.author) ?? "",
    mergeState: pull.mergeStateStatus.toLowerCase(),
    reviews: pull.reviews.nodes.map(toReview).filter((review) => review !== null),
    comments: pull.comments.nodes.map(toComment),
    checks: (pull.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(toCheck),
    requested: pull.reviewRequests.nodes
      .map(({ requestedReviewer: reviewer }) =>
        reviewer?.__typename === "Team" ? reviewer.slug : reviewer?.login && loginOf({ login: reviewer.login, __typename: reviewer.__typename }),
      )
      .filter((login): login is string => Boolean(login)),
  };
}

type Variables = Record<string, string | number>;

async function graphql(query: string, variables: Variables): Promise<PullRequestNode> {
  const args = Object.entries(variables).flatMap(([key, value]) => [typeof value === "number" ? "-F" : "-f", `${key}=${value}`]);
  const response = JSON.parse(await gh(["api", "graphql", ...args, "-f", `query=${query}`])) as {
    data?: { repository: { pullRequest: PullRequestNode | null } | null };
    errors?: { message: string }[];
  };
  if (response.errors?.length) throw new Error(`GitHub GraphQL: ${response.errors.map((error) => error.message).join("; ")}`);
  const pull = response.data?.repository?.pullRequest;
  if (!pull) throw new Error(`${variables.owner}/${variables.name}#${variables.number} is not readable: no such pull request, or no access`);
  return pull;
}

/** Reads the other pages of a connection, older pages first or newer pages last, and returns all its nodes. */
async function allNodes<T>(
  first: Page<T>,
  direction: "older" | "newer",
  query: string,
  variables: Variables,
  pageOf: (pull: PullRequestNode) => Page<T> | undefined,
): Promise<T[]> {
  let nodes = first.nodes;
  let info = first.pageInfo;
  const seen = new Set<string>();
  while (true) {
    const cursor = direction === "older" ? info?.hasPreviousPage && info.startCursor : info?.hasNextPage && info.endCursor;
    if (!cursor) return nodes;
    if (seen.has(cursor)) throw new Error(`GitHub GraphQL gave the same page cursor twice for ${variables.owner}/${variables.name}#${variables.number}`);
    seen.add(cursor);
    const page = pageOf(await graphql(query, { ...variables, cursor }));
    if (!page || page.nodes.length === 0) return nodes;
    nodes = direction === "older" ? [...page.nodes, ...nodes] : [...nodes, ...page.nodes];
    info = page.pageInfo;
  }
}

export async function fetchPullRequest(pr: PullRequest): Promise<PullRequestSnapshot> {
  const [owner = "", name = ""] = pr.repo.split("/");
  const variables = { owner, name, number: pr.number };
  const pull = await graphql(QUERY, variables);
  type Pages = { page?: Page<never> };
  const page = (value: unknown) => (value as Pages).page;
  const rollup = pull.commits.nodes[0]?.commit.statusCheckRollup;
  const [reviews, comments, contexts] = await Promise.all([
    allNodes(pull.reviews, "older", PAGE_QUERIES.reviews, variables, page),
    allNodes(pull.comments, "older", PAGE_QUERIES.comments, variables, page),
    rollup
      ? allNodes(rollup.contexts, "newer", PAGE_QUERIES.contexts, variables, (next) => page(next.commits.nodes[0]?.commit.statusCheckRollup))
      : Promise.resolve([]),
  ]);
  return toSnapshot({
    ...pull,
    reviews: { nodes: reviews },
    comments: { nodes: comments },
    commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { contexts: { nodes: contexts } } : null } }] },
  });
}

export async function postCommand(pr: PullRequest, command: Command): Promise<string> {
  const url = await gh(["pr", "comment", String(pr.number), "--repo", pr.repo, "--body", commandBody(command)]);
  return url.trim();
}

/**
 * Merges the pull request with the first method that the repository allows: squash, merge, then rebase.
 * The repository settings decide if GitHub deletes the branch.
 * GitHub refuses the merge if the pull request has a newer head than the one that the user confirmed.
 */
export async function mergePullRequest(pr: PullRequest, head: string): Promise<void> {
  const allowed = JSON.parse(
    await gh(["api", `repos/${pr.repo}`, "--jq", "{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}"]),
  ) as Record<"squash" | "merge" | "rebase", boolean>;
  const method = (["squash", "merge", "rebase"] as const).find((candidate) => allowed[candidate]);
  if (!method) throw new Error(`${pr.repo} allows no merge method`);
  await gh(["pr", "merge", String(pr.number), "--repo", pr.repo, `--${method}`, "--match-head-commit", head]);
}

export function openInBrowser(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
