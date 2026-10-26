---
title: Reviewers and checks
description: How boo finds the reviewers, reads PR-Agent, and decides the approval and the checks.
---

## Reviewers

- A reviewer is a person or a bot that submitted a review, that GitHub asks for a review,
  CodeRabbit if it commented, or PR-Agent if it posted its review comment. The tool knows no list
  of bots, so a new reviewer needs no change. A bot that only comments, such as Linear or a preview
  deployment, is not a reviewer.
- The author of the pull request is not a reviewer: their reviews are replies in the threads.
- A review whose line comments all answer an earlier comment is a reply in a thread, not a
  review. A review with an empty body and its own line comments is a review: Greptile puts all its
  findings on the lines.
- A review that says `quota`, `rate limit`, `limit reached`, `unable to review` or `usage limit` in
  its first paragraph is a refusal, not a review. A real review can quote the quota of another
  reviewer further down, so the rest of the body does not count.
- A reviewer reviews now if it has a running check with its name (`claude-review` for
  `sakuga-claude-review[bot]`), or if its last review or comment shows a progress below its total
  (`2/3 files`) on its first line. A progress further down is a quote, a list or an example.

## PR-Agent

[PR-Agent](https://github.com/The-PR-Agent/pr-agent) submits no GitHub review: its review is one
comment ("PR Reviewer Guide"), which it edits at each new review. The login of that comment is the
reviewer, so each install works under its own name (`sakuga-review[bot]` at Sakuga).

- The mark comes from the "Merge recommendation" line: `Safe to merge` gives `✔`, `Changes
  required` gives `✎`, and all the rest, or no such line, gives `●`. It is the opinion of a model,
  not a GitHub verdict: it gives no `approved`, no `ready to merge` and no `changes requested`
  state to the pull request.
- An edited comment names the commit that it covers ("Review updated until commit …"). If that
  commit is not the head commit, the review is stale (`◌`).
- A comment with no edit covers the head commit, unless the head commit has checks with `pr-agent`
  in their name and none of them passed: then the review is stale.
- A running check with `pr-agent` in its name on the head commit means that PR-Agent reviews now
  (`⟳`).
- The line suggestions of `/improve` count as reviews, but do not change the mark.

## Approval and checks

- The approval follows the rule of GitHub: the last review of each reviewer that approves,
  requests changes or is dismissed stands, on any commit. One request for changes wins over all the
  approvals. A later comment review, such as a reply, does not replace a verdict.
- `ready to merge` needs an approval, no request for changes, no failing or running check, and a
  merge state that GitHub accepts (`clean`, `unstable` or `has_hooks`).
- A check counts as a quota check, and not as a failure, if its description names a quota
  (CodeRabbit: "Review rate limited"), or if it fails and belongs to a reviewer that refused for
  quota. A red check of a refused reviewer tells nothing about the code.
- A check of a cancelled run does not fail if a newer run of the same workflow, on the same commit,
  has the same check, and that check passed or still runs. A push and a change of base can start a
  workflow twice, and a concurrency rule cancels one run. The details show
  `⊘ e2e · cancelled by a newer run`.
- A GitHub Actions workflow whose last run on the head commit has not ended counts as one running
  check, with the name of the workflow, if no check of that run runs. A queued run has no check yet,
  and a run between two jobs can have only finished checks: without this rule, the pull request
  could show `ready to merge` before its CI starts. Only the last run of each workflow counts. A
  queued run replaces the checks of an older cancelled run of the same workflow. The check suites of
  the other apps do not count: many of them stay queued for ever.
- Each failing check shows its cause in the details: `✖ Migrations · fails on main too` if the same
  check fails on the last commit of the base branch, else `✖ Migrations · fails here only`. A check
  that fails on the base branch too still counts as failing: the pull request cannot merge green.
