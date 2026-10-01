import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_LOGIN, type Comment, type Decision, type Review } from "./decide.js";
import { toSnapshot } from "./github.js";
import { checkBelongsTo, displayName, summarize, summarizeChecks, type Check, type PullRequestFacts } from "./reviewers.js";

const now = new Date("2026-09-28T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const CLAUDE = "sakuga-claude-review[bot]";
const COPILOT = "copilot-pull-request-reviewer[bot]";
const GREPTILE = "greptile-apps[bot]";
const VORTEX = "mergestorm-vortex[bot]";
const COPILOT_REFUSAL = "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.";

const review = (login: string, commit: string, minutesAgo: number, state = "COMMENTED", body = "findings", threadReply = false): Review => ({
  user: { login },
  commit_id: commit,
  submitted_at: ago(minutesAgo),
  state,
  body,
  threadReply,
});

const facts = (patch: Partial<PullRequestFacts>): PullRequestFacts => ({
  head: "head",
  author: "Mheaus",
  mergeState: "clean",
  reviews: [],
  comments: [],
  checks: [],
  requested: [],
  now,
  ...patch,
});

test("a quota refusal on the head commit is not a review of it", () => {
  const { reviewers, overall } = summarize(facts({ reviews: [review(COPILOT, "head", 5, "COMMENTED", COPILOT_REFUSAL)] }));
  assert.deepEqual(reviewers.map(({ name, status, reviews }) => ({ name, status, reviews })), [{ name: "copilot", status: "quota", reviews: 0 }]);
  assert.equal(overall, "quota");
});

test("a review that quotes the quota of another reviewer is still a review", () => {
  const body = "### ⛔ 2 blocking findings\n\n**Earlier findings** none — Copilot and CodeRabbit both stopped on quota and left no line comment";
  const [reviewer] = summarize(facts({ reviews: [review(CLAUDE, "head", 5, "COMMENTED", body)] })).reviewers;
  assert.deepEqual([reviewer!.status, reviewer!.reviews], ["commented", 1]);
});

test("an empty review with its own line comments is a review, and a thread reply of the author is not", () => {
  const { reviewers, onHead } = summarize(
    facts({ reviews: [review(GREPTILE, "head", 10, "COMMENTED", ""), review("Mheaus", "head", 5, "COMMENTED", "", true)] }),
  );
  assert.deepEqual(reviewers.map((reviewer) => [reviewer.name, reviewer.status]), [["greptile", "commented"]]);
  assert.equal(onHead, 1);
});

test("a review of an older commit is stale, and its verdict still stands as on GitHub", () => {
  const summary = summarize(
    facts({ reviews: [review(CLAUDE, "old", 60, "CHANGES_REQUESTED"), review(GREPTILE, "head", 5, "APPROVED")] }),
  );
  assert.deepEqual(summary.reviewers.map((reviewer) => [reviewer.name, reviewer.status, reviewer.verdict]), [
    ["greptile", "approved", "approved"],
    ["sakuga-claude-review", "stale", "changes requested"],
  ]);
  assert.equal(summary.overall, "changes requested");
});

test("an approval with green checks and a clean merge state is ready", () => {
  const checks: Check[] = [{ name: "test", state: "success" }, { name: "e2e", state: "skipped" }];
  assert.equal(summarize(facts({ reviews: [review(CLAUDE, "head", 5, "APPROVED")], checks })).overall, "ready");
  assert.equal(summarize(facts({ reviews: [review(CLAUDE, "head", 5, "APPROVED")], checks, mergeState: "blocked" })).overall, "approved");
  assert.equal(
    summarize(facts({ reviews: [review(CLAUDE, "head", 5, "APPROVED")], checks: [...checks, { name: "build", state: "pending" }] })).overall,
    "approved",
  );
});

test("a conflict wins over everything, then a request for changes, then a failed check", () => {
  const approved = [review(CLAUDE, "head", 5, "APPROVED")];
  const failed: Check[] = [{ name: "test", state: "failure" }];
  assert.equal(summarize(facts({ reviews: approved, checks: failed, mergeState: "dirty" })).overall, "conflicts");
  assert.equal(summarize(facts({ reviews: approved, checks: failed })).overall, "checks failing");
});

test("a progress bar below its total and a running check of the reviewer both mean reviewing", () => {
  const partial = review(VORTEX, "old", 2, "COMMENTED", "Review progress `███░░` 2/3 files");
  const byProgress = summarize(facts({ reviews: [partial] })).reviewers[0]!;
  assert.equal(byProgress.status, "reviewing");
  assert.deepEqual(byProgress.progress, { done: 2, total: 3 });

  const byCheck = summarize(facts({ reviews: [review(CLAUDE, "old", 30)], checks: [{ name: "claude-review", state: "pending" }] }));
  assert.equal(byCheck.reviewers[0]!.status, "reviewing");
  assert.equal(byCheck.overall, "reviewing");
});

test("a finished review after a partial progress ends the progress", () => {
  const partial = review(VORTEX, "old", 20, "COMMENTED", "Review progress `███░░` 2/3 files");
  const [reviewer] = summarize(facts({ reviews: [partial, review(VORTEX, "head", 5, "APPROVED", "All good.")] })).reviewers;
  assert.deepEqual([reviewer!.status, reviewer!.progress], ["approved", undefined]);
});

test("a thread reply during a partial progress keeps the reviewer reviewing", () => {
  const partial = review(VORTEX, "old", 20, "COMMENTED", "Review progress `███░░` 2/3 files");
  const reply = review(VORTEX, "old", 5, "COMMENTED", "", true);
  assert.equal(summarize(facts({ reviews: [partial, reply] })).reviewers[0]!.status, "reviewing");
});

test("a review that quotes a progress further down is not in progress", () => {
  const body = "### ⛔ 3 blocking findings\n\n- A reviewer that posts `2/3 files` and then approves stays reviewing.";
  const [reviewer] = summarize(facts({ reviews: [review(CLAUDE, "old", 5, "COMMENTED", body)] })).reviewers;
  assert.deepEqual([reviewer!.status, reviewer!.progress], ["stale", undefined]);
});

test("a progress after the first line, or on a first line that is code, a quote or a list item, is not live", () => {
  const bodies = [
    "All good.\n\nReview progress `██░` 2/3 files",
    "All good.\n\n```\nReview progress 2/3 files\n```",
    "~~~text\nProgress: 2/3 files\n~~~\n\nAll good.",
    "> Review progress 2/3 files\n\nAll good.",
    "All good.\n\n> The reviewer said:\nReview progress 2/3 files",
    "All good.\n```\nReview progress 2/3 files\n```",
    "All good.\n> Review progress 2/3 files",
    "Findings:\n- \"2/3 files\" is what the bar showed.",
    "- 2/3 files reviewed so far\n\nAll good.",
  ];
  for (const body of bodies) {
    const [reviewer] = summarize(facts({ reviews: [review(VORTEX, "head", 5, "APPROVED", body)] })).reviewers;
    assert.deepEqual([reviewer!.status, reviewer!.progress], ["approved", undefined], body);
  }
});

test("a complete progress bar is a finished review", () => {
  const done = review(VORTEX, "head", 2, "COMMENTED", "Review progress `██████████` 3/3 files\n\n**Comment** — found 1 issue(s)");
  assert.equal(summarize(facts({ reviews: [done] })).reviewers[0]!.status, "commented");
});

test("a requested reviewer with no review waits, and the author is never a reviewer", () => {
  const { reviewers, overall } = summarize(facts({ requested: ["alice", "Mheaus"] }));
  assert.deepEqual(reviewers.map((reviewer) => [reviewer.name, reviewer.status, reviewer.bot]), [["alice", "requested", false]]);
  assert.equal(overall, "awaiting review");
});

test("the CodeRabbit decision gives its status and its quota time", () => {
  const availableAt = new Date(now.getTime() + 10 * 60_000);
  const coderabbit: Decision = { kind: "wait", availableAt, delayGuessed: false };
  const [reviewer] = summarize(facts({ coderabbit })).reviewers;
  assert.deepEqual([reviewer!.name, reviewer!.status, reviewer!.until], ["coderabbitai", "quota", availableAt]);
  assert.equal(summarize(facts({ coderabbit: { kind: "unseen" } })).reviewers.length, 0);
});

test("a quota refusal gives a return time if its body has a delay", () => {
  const refusal = review(COPILOT, "head", 10, "COMMENTED", "Review rate limited. Next review available in 30 minutes.");
  const [reviewer] = summarize(facts({ reviews: [refusal] })).reviewers;
  assert.deepEqual(reviewer!.until, new Date(now.getTime() + 20 * 60_000));
});

test("a red check of a refused reviewer and a status that names a quota are quota checks, not failures", () => {
  const refusal = review(COPILOT, "head", 5, "COMMENTED", COPILOT_REFUSAL);
  const checks: Check[] = [
    { name: "copilot-pull-request-reviewer", state: "failure" },
    { name: "CodeRabbit", state: "success", description: "Review rate limited" },
    { name: "lint", state: "failure" },
    { name: "test", state: "success" },
  ];
  const summary = summarizeChecks(checks, summarize(facts({ reviews: [refusal] })).reviewers);
  assert.deepEqual(summary, { total: 4, passed: 1, skipped: 0, pending: 0, failed: ["lint"], quota: 2 });
});

const SAKUGA = "sakuga-review[bot]";
const HEAD = "b6aafaac00b762232d1aa1e5b973cc9eea4d3939";
const guide = (advice: string, commit?: string, minutesAgo = 5): Comment => ({
  user: { login: SAKUGA },
  body: [
    "## PR Reviewer Guide 🔍\n\n<!-- pr-agent:review:full -->\n",
    commit ? `#### (Review updated until commit https://github.com/sakuga-software/suricarte/commit/${commit})\n` : "",
    `<table>\n<tr><td>✅&nbsp;<strong>Merge recommendation</strong>: ${advice}</td></tr>\n</table>`,
  ].join("\n"),
  created_at: ago(60),
  updated_at: ago(minutesAgo),
});
const prAgentCheck = (state: Check["state"]): Check => ({ name: "pr_agent / PR Agent", state });

test("a PR-Agent review comment makes a reviewer, and its recommendation is not a GitHub verdict", () => {
  const { reviewers, overall, reviews, onHead } = summarize(facts({ head: HEAD, comments: [guide("Safe to merge", HEAD)] }));
  assert.deepEqual(
    reviewers.map(({ name, status, verdict, prAgent }) => ({ name, status, verdict, prAgent })),
    [{ name: "sakuga-review", status: "approved", verdict: undefined, prAgent: true }],
  );
  assert.deepEqual([overall, reviews, onHead], ["reviewed", 1, 1]);
  const status = (advice: string) => summarize(facts({ head: HEAD, comments: [guide(advice, HEAD)] })).reviewers[0]!.status;
  assert.deepEqual([status("Merge with caution"), status("Changes required")], ["commented", "changes requested"]);
});

test("a PR-Agent review that names an older commit is stale", () => {
  const [reviewer] = summarize(facts({ head: HEAD, comments: [guide("Safe to merge", "a".repeat(40))] })).reviewers;
  assert.equal(reviewer!.status, "stale");
});

test("a PR-Agent review with no edit covers the head commit, unless none of its checks on that commit passed", () => {
  const status = (checks: Check[]) => summarize(facts({ comments: [guide("Merge with caution")], checks })).reviewers[0]!.status;
  assert.deepEqual(
    [status([]), status([prAgentCheck("skipped"), prAgentCheck("success")]), status([prAgentCheck("failure")]), status([prAgentCheck("pending")])],
    ["commented", "commented", "stale", "reviewing"],
  );
});

test("the line suggestions of PR-Agent on an older commit do not replace its review comment", () => {
  const { reviewers } = summarize(facts({ head: HEAD, reviews: [review(SAKUGA, "old", 30, "COMMENTED", "")], comments: [guide("Safe to merge", HEAD)] }));
  assert.deepEqual(reviewers.map(({ status, reviews, lastReviewAt }) => [status, reviews, lastReviewAt]), [["approved", 2, new Date(ago(5))]]);
});

test("the other PR-Agent comments and a quote of its review by a person make no reviewer", () => {
  const other = (login: string, body: string): Comment => ({ user: { login }, body, created_at: ago(5), updated_at: ago(5) });
  const comments = [other(SAKUGA, "## PR Code Suggestions ✨\n\n<!-- pr-agent:improve:no-suggestions -->"), other("alice", "> ## PR Reviewer Guide 🔍\n\nI agree.")];
  assert.equal(summarize(facts({ comments })).reviewers.length, 0);
});

test("a check belongs to a reviewer by its name", () => {
  assert.ok(checkBelongsTo("claude-review", CLAUDE));
  assert.ok(checkBelongsTo("Greptile Review", GREPTILE));
  assert.ok(checkBelongsTo("CodeRabbit", BOT_LOGIN));
  assert.ok(!checkBelongsTo("lint", CLAUDE));
  assert.ok(!checkBelongsTo("[code]smith", GREPTILE));
  assert.ok(checkBelongsTo("copilot-pull-request-reviewer", COPILOT));
});

test("a check does not belong to a reviewer because they share one word", () => {
  assert.ok(!checkBelongsTo("test", "test-review[bot]"));
  assert.ok(!checkBelongsTo("sakuga-build", CLAUDE));
  assert.ok(!checkBelongsTo("review", CLAUDE));
});

test("a failing check with the first word of a refused reviewer still fails", () => {
  const refusal = review("test-review[bot]", "head", 5, "COMMENTED", "Unable to review: usage limit reached.");
  const summary = summarize(facts({ reviews: [refusal, review(CLAUDE, "head", 5, "APPROVED")], checks: [{ name: "test", state: "failure" }] }));
  assert.deepEqual(summary.checks.failed, ["test"]);
  assert.equal(summary.overall, "checks failing");
});

test("the display name drops the bot suffixes", () => {
  assert.equal(displayName(COPILOT), "copilot");
  assert.equal(displayName(GREPTILE), "greptile");
  assert.equal(displayName(BOT_LOGIN), "coderabbitai");
});

test("the count of reviews and the last reviewer skip the refusals", () => {
  const summary = summarize(
    facts({
      reviews: [review(CLAUDE, "old", 60), review(CLAUDE, "head", 20, "APPROVED"), review(COPILOT, "head", 5, "COMMENTED", COPILOT_REFUSAL)],
    }),
  );
  assert.equal(summary.reviews, 2);
  assert.deepEqual(summary.lastReview, { name: "sakuga-claude-review", at: new Date(ago(20)) });
});

test("the snapshot restores the bot suffix and marks the thread replies", () => {
  const bot = (login: string) => ({ login, __typename: "Bot" });
  const node = (id: number, minutesAgo: number) => ({ databaseId: id, author: bot("coderabbitai"), body: `c${id}`, createdAt: ago(minutesAgo), updatedAt: ago(minutesAgo) });
  const snapshot = toSnapshot({
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeStateStatus: "UNSTABLE",
    headRefOid: "head",
    author: { login: "Mheaus", __typename: "User" },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Bot", login: "greptile-apps" } }] },
    reviews: {
      nodes: [
        { author: bot("greptile-apps"), state: "COMMENTED", submittedAt: ago(10), body: "", commit: { oid: "head" }, comments: { totalCount: 1, nodes: [{ replyTo: null }] } },
        { author: { login: "Mheaus", __typename: "User" }, state: "COMMENTED", submittedAt: ago(5), body: "", commit: { oid: "head" }, comments: { totalCount: 1, nodes: [{ replyTo: { id: "x" } }] } },
        { author: bot("greptile-apps"), state: "COMMENTED", submittedAt: ago(4), body: "", commit: { oid: "head" }, comments: { totalCount: 11, nodes: [{ replyTo: { id: "y" } }] } },
      ],
    },
    comments: { nodes: [node(1, 50), node(2, 40), node(3, 30)] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null },
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "TIMED_OUT" },
      { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS", description: "Review rate limited" },
    ] } } } }] },
  });
  assert.equal(snapshot.mergeState, "unstable");
  assert.deepEqual(snapshot.requested, ["greptile-apps[bot]"]);
  assert.deepEqual(snapshot.comments.map((comment: Comment) => [comment.id, comment.user?.login]), [
    [1, BOT_LOGIN],
    [2, BOT_LOGIN],
    [3, BOT_LOGIN],
  ]);
  assert.deepEqual(snapshot.reviews.map((item) => [item.user?.login, item.threadReply]), [
    [GREPTILE, false],
    ["Mheaus", true],
    [GREPTILE, false],
  ]);
  assert.deepEqual(snapshot.checks, [
    { name: "lint", state: "pending" },
    { name: "test", state: "failure" },
    { name: "CodeRabbit", state: "success", description: "Review rate limited" },
  ]);
});
