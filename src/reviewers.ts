import { BOT_LOGIN, isThreadReply, parseDelay, reviewVerdict, type Comment, type Decision, type Review, type Verdict } from "./decide.js";

export type CheckState = "pending" | "success" | "failure" | "skipped";

export interface Check {
  name: string;
  state: CheckState;
  description?: string;
}

export type ReviewerStatus =
  | Verdict
  | "reviewing"
  | "quota"
  | "to retry"
  | "requested"
  | "stale"
  | "skipped"
  | "paused";

export interface Reviewer {
  login: string;
  name: string;
  bot: boolean;
  status: ReviewerStatus;
  /** The verdict that stands, with the rule of GitHub, over all the commits. */
  verdict?: Verdict;
  /** The real reviews: no thread reply and no quota refusal. */
  reviews: number;
  lastReviewAt?: Date;
  /** The time when the quota of the reviewer comes back, if a notice gives it. */
  until?: Date;
  progress?: { done: number; total: number };
}

export interface PullRequestFacts {
  head: string;
  author: string;
  mergeState: string;
  reviews: Review[];
  comments: Comment[];
  checks: Check[];
  requested: string[];
  now: Date;
  /** The CodeRabbit decision. It knows the quota clock of CodeRabbit better than a generic rule. */
  coderabbit?: Decision;
}

// The same words as the pr-signals.sh script of the review skills. They name no bot, so a new reviewer needs no edit.
const QUOTA = /quota|rate.limit|limit reached|unable to review|usage limit/i;
// Some reviewers show their progress in their review body, for example "Review progress `███░░` 2/3 files".
const PROGRESS = /(\d+)\s*\/\s*(\d+)\s+files/;

export const isBotLogin = (login: string) => login.endsWith("[bot]") || login === "Copilot";
export const displayName = (login: string) => login.replace(/\[bot\]$/, "").replace(/-(apps|bot|pull-request-reviewer)$/, "");
const time = (iso: string) => Date.parse(iso);
// A refusal and a progress bar sit in the first paragraph of a body. A review can quote both words further down.
const firstParagraph = (body = "") => body.trimStart().split(/\n\s*\n/)[0]!;
const isRefusal = (body = "") => QUOTA.test(firstParagraph(body));
// A progress bar counts in the first paragraph, or on a line at column 0 that starts with "progress" or "review progress".
// Column 0 excludes an indented code block.
const PROGRESS_LINE = /^(?:review\s+)?progress\b[^\n]*?(\d+)\s*\/\s*(\d+)\s+files/im;
// A code block or a quote only shows an example. The progress of a review is in the prose of its body.
// A quote runs from its first ">" line to the end of its paragraph, because Markdown continues it on lines with no ">".
const FENCED_BLOCK = /^[^\S\n]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[^\S\n]*\1[^\n]*$|(?![\s\S]))/gm;
const QUOTE_PARAGRAPH = /^[^\S\n]*>[\s\S]*?(?=\n[^\S\n]*\n|(?![\s\S]))/gm;
const prose = (body: string) => body.replace(FENCED_BLOCK, "").replace(QUOTE_PARAGRAPH, "");
const progressIn = (body: string) => {
  const text = prose(body);
  return PROGRESS.exec(firstParagraph(text)) ?? PROGRESS_LINE.exec(text);
};
const slug = (text: string) => text.toLowerCase().replace(/\[bot\]$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Tells if a check belongs to a reviewer. No API links a check to a login, so the rule compares names:
 * - "claude-review" belongs to "sakuga-claude-review[bot]": the login ends with the check name;
 * - "Greptile Review" belongs to "greptile-apps[bot]": the same name without "review" and "apps";
 * - "CodeRabbit" belongs to "coderabbitai[bot]".
 * A check with one word matches only the whole name, so "test" does not belong to "test-review[bot]".
 */
export function checkBelongsTo(check: string, login: string): boolean {
  const name = slug(check);
  const owner = slug(login).replace(/(-(apps?|bot))+$/, "");
  const core = name.replace(/-reviews?$|-reviewer$/, "");
  return name === owner || (name.includes("-") && owner.endsWith(`-${name}`)) || (core !== name && core === owner) || owner === `${name}ai`;
}

function quotaUntil(refusal: Review, comments: Comment[]): Date | undefined {
  const notices = [
    { at: time(refusal.submitted_at), body: refusal.body ?? "" },
    ...comments
      .filter((comment) => comment.user?.login === refusal.user?.login && isRefusal(comment.body))
      .map((comment) => ({ at: time(comment.updated_at), body: comment.body })),
  ].toSorted((a, b) => a.at - b.at);
  for (const notice of notices.toReversed()) {
    const delay = parseDelay(notice.body);
    if (delay !== null) return new Date(notice.at + delay);
  }
  return undefined;
}

// Only the newest progress counts. A review with no progress after it ends the progress. A thread reply does not.
function progressOf(login: string, reviews: Review[], comments: Comment[]) {
  const bodies = [
    ...reviews.filter((review) => review.user?.login === login && !isThreadReply(review)).map((review) => ({ at: time(review.submitted_at), body: review.body ?? "", review: true })),
    ...comments.filter((comment) => comment.user?.login === login).map((comment) => ({ at: time(comment.updated_at), body: comment.body, review: false })),
  ].toSorted((a, b) => a.at - b.at);
  const last = bodies.findLast(({ body, review }) => review || progressIn(body) !== null);
  const match = last && progressIn(last.body);
  return match ? { done: Number(match[1]), total: Number(match[2]) } : undefined;
}

function genericReviewer(login: string, facts: PullRequestFacts): Reviewer {
  const own = facts.reviews
    .filter((review) => review.user?.login === login && !isThreadReply(review))
    .toSorted((a, b) => time(a.submitted_at) - time(b.submitted_at));
  const real = own.filter((review) => !isRefusal(review.body));
  const lastRefusal = own.findLast((review) => isRefusal(review.body));
  const last = real.at(-1);
  const base = {
    login,
    name: displayName(login),
    bot: isBotLogin(login),
    reviews: real.length,
    ...(real.length > 0 && { verdict: reviewVerdict(real) }),
    ...(last && { lastReviewAt: new Date(last.submitted_at) }),
  };

  const progress = progressOf(login, facts.reviews, facts.comments);
  const running = facts.checks.some((check) => check.state === "pending" && checkBelongsTo(check.name, login));
  if (running || (progress && progress.done < progress.total)) {
    return { ...base, status: "reviewing", ...(progress && progress.done < progress.total && { progress }) };
  }
  if (real.some((review) => review.commit_id === facts.head)) return { ...base, status: reviewVerdict(real) };
  if (lastRefusal && (!last || time(last.submitted_at) < time(lastRefusal.submitted_at))) {
    const until = quotaUntil(lastRefusal, facts.comments);
    return { ...base, status: "quota", ...(until && { until }) };
  }
  if (facts.requested.includes(login)) return { ...base, status: "requested" };
  return { ...base, status: "stale" };
}

function coderabbitStatus(decision: Decision, reviewer: Reviewer): Pick<Reviewer, "status" | "until"> {
  switch (decision.kind) {
    case "reviewed":
      return { status: decision.verdict };
    case "busy":
      return { status: "reviewing" };
    case "wait":
      return { status: "quota", until: decision.availableAt };
    case "trigger":
      return { status: "to retry" };
    case "pending":
      return { status: "requested" };
    case "skipped":
      return { status: "skipped" };
    case "paused":
      return { status: "paused" };
    default:
      return { status: reviewer.reviews > 0 ? "stale" : "requested" };
  }
}

/**
 * Returns one entry for each reviewer of the pull request, in the order of their names. A reviewer is
 * a person or a bot that submitted a review or that GitHub asks for one, and CodeRabbit if it commented.
 * The author of the pull request is not a reviewer: their reviews are replies in the threads.
 */
export function reviewersOf(facts: PullRequestFacts): Reviewer[] {
  const logins = new Set([
    ...facts.reviews.filter((review) => !isThreadReply(review) && review.user).map((review) => review.user!.login),
    ...facts.requested,
  ]);
  if (facts.coderabbit && facts.coderabbit.kind !== "unseen") logins.add(BOT_LOGIN);
  logins.delete(facts.author);

  return [...logins]
    .map((login) => {
      const reviewer = genericReviewer(login, facts);
      if (login !== BOT_LOGIN || !facts.coderabbit) return reviewer;
      const { until, ...rest } = reviewer;
      return { ...rest, ...coderabbitStatus(facts.coderabbit, reviewer) };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export interface ChecksSummary {
  total: number;
  passed: number;
  skipped: number;
  pending: number;
  failed: string[];
  /** The checks that report a quota refusal of a reviewer, and not a result on the code. */
  quota: number;
}

/**
 * Sorts the checks of the head commit. A check is a quota check in these cases:
 * - its description names a quota;
 * - it fails and belongs to a reviewer that refused for quota.
 * A red check of a refused reviewer tells nothing about the code.
 */
export function summarizeChecks(checks: Check[], reviewers: Reviewer[]): ChecksSummary {
  const refused = reviewers.filter((reviewer) => reviewer.status === "quota" || reviewer.status === "to retry");
  const summary: ChecksSummary = { total: checks.length, passed: 0, skipped: 0, pending: 0, failed: [], quota: 0 };
  for (const check of checks) {
    const quota =
      QUOTA.test(check.description ?? "") ||
      (check.state === "failure" && refused.some((reviewer) => checkBelongsTo(check.name, reviewer.login)));
    if (quota) summary.quota++;
    else if (check.state === "success") summary.passed++;
    else if (check.state === "skipped") summary.skipped++;
    else if (check.state === "pending") summary.pending++;
    else summary.failed.push(check.name);
  }
  return summary;
}

export type Overall =
  | "conflicts"
  | "changes requested"
  | "checks failing"
  | "ready"
  | "approved"
  | "reviewing"
  | "reviewed"
  | "quota"
  | "awaiting review";

const ON_HEAD: readonly ReviewerStatus[] = ["approved", "changes requested", "commented"];
// GitHub mergeable states that let an approved pull request merge. "unstable" means that a check fails,
// and summarizeChecks already decides if that check counts.
const MERGEABLE = new Set(["clean", "has_hooks", "unstable"]);

export interface Summary {
  reviewers: Reviewer[];
  checks: ChecksSummary;
  overall: Overall;
  /** The reviewers whose last review covers the head commit. */
  onHead: number;
  reviews: number;
  lastReview?: { name: string; at: Date };
}

/**
 * Sums up a pull request. The approval follows the rule of GitHub over the standing verdict of each
 * reviewer: one request for changes wins over all the approvals.
 */
export function summarize(facts: PullRequestFacts): Summary {
  const reviewers = reviewersOf(facts);
  const checks = summarizeChecks(facts.checks, reviewers);
  const changes = reviewers.some((reviewer) => reviewer.verdict === "changes requested");
  const approved = !changes && reviewers.some((reviewer) => reviewer.verdict === "approved");
  const any = (...statuses: ReviewerStatus[]) => reviewers.some((reviewer) => statuses.includes(reviewer.status));

  const overall: Overall =
    facts.mergeState === "dirty" ? "conflicts"
    : changes ? "changes requested"
    : checks.failed.length > 0 ? "checks failing"
    : approved && checks.pending === 0 && MERGEABLE.has(facts.mergeState) ? "ready"
    : approved ? "approved"
    : any("reviewing") ? "reviewing"
    : any(...ON_HEAD) ? "reviewed"
    : any("quota", "to retry") ? "quota"
    : "awaiting review";

  const last = reviewers
    .filter((reviewer) => reviewer.lastReviewAt)
    .toSorted((a, b) => a.lastReviewAt!.getTime() - b.lastReviewAt!.getTime())
    .at(-1);
  return {
    reviewers,
    checks,
    overall,
    onHead: reviewers.filter((reviewer) => ON_HEAD.includes(reviewer.status)).length,
    reviews: reviewers.reduce((total, reviewer) => total + reviewer.reviews, 0),
    ...(last && { lastReview: { name: last.name, at: last.lastReviewAt! } }),
  };
}
