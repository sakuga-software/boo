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
    "--limit", "200",
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

// The first comments hold the CodeRabbit summary. The last ones hold the recent replies.
// A long pull request can have more than 100 comments, so the query reads both ends.
const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft merged mergeStateStatus headRefOid
      author { login __typename }
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } }
      reviews(last: 100) { nodes { author { login __typename } state submittedAt body commit { oid } comments(first: 10) { nodes { replyTo { id } } } } }
      first: comments(first: 10) { nodes { ...comment } }
      last: comments(last: 100) { nodes { ...comment } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion }
        ... on StatusContext { context state description }
      } } } } } }
    }
  }
}
fragment comment on IssueComment { databaseId author { login __typename } body createdAt updatedAt }
`;

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
  comments: { nodes: { replyTo: { id: string } | null }[] };
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
  reviews: { nodes: ReviewNode[] };
  first: { nodes: CommentNode[] };
  last: { nodes: CommentNode[] };
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: ContextNode[] } } | null } }[] };
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
  const comments = node.comments.nodes;
  const threadReply = node.body === "" && comments.length > 0 && comments.every((comment) => comment.replyTo !== null);
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
  const comments = new Map([...pull.first.nodes, ...pull.last.nodes].map((node) => [node.databaseId, toComment(node)]));
  return {
    status: statusOf(pull),
    head: pull.headRefOid,
    author: loginOf(pull.author) ?? "",
    mergeState: pull.mergeStateStatus.toLowerCase(),
    reviews: pull.reviews.nodes.map(toReview).filter((review) => review !== null),
    comments: [...comments.values()].toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    checks: (pull.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(toCheck),
    requested: pull.reviewRequests.nodes
      .map(({ requestedReviewer: reviewer }) =>
        reviewer?.__typename === "Team" ? reviewer.slug : reviewer?.login && loginOf({ login: reviewer.login, __typename: reviewer.__typename }),
      )
      .filter((login): login is string => Boolean(login)),
  };
}

export async function fetchPullRequest(pr: PullRequest): Promise<PullRequestSnapshot> {
  const [owner, name] = pr.repo.split("/");
  const output = await gh(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`, "-f", `query=${QUERY}`]);
  const pull = (JSON.parse(output) as { data: { repository: { pullRequest: PullRequestNode } } }).data.repository.pullRequest;
  return toSnapshot(pull);
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
