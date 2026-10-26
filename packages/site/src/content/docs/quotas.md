---
title: Quotas and retries
description: The retries of the review bots after a quota refusal, the CodeRabbit clock, and the GitHub points of the watch.
---

## Retries of the other bots

The automatic retry of a bot other than CodeRabbit is off by default. When it is on:

- the bot gets a retry if its last review of the pull request is a quota refusal;
- the retry waits for the return time that the refusal gives, or 1 hour after the refusal if it
  gives no time;
- the tool posts the first command of the bot, or asks GitHub for a review if the bot takes review
  requests (Copilot);
- each refusal gets one retry only. A new refusal after the retry gives a new retry.
- if the post fails, for example because the bot is not a collaborator, a red message says why,
  and the tool tries again 5 minutes later.

With `--watch`, the details of the selected pull request show the time of each planned retry. Without
`--watch`, the tool posts only the retries that are due, and then stops.

## CodeRabbit retries

CodeRabbit is the reviewer that the tool can ask again by itself.

- A commit counts as reviewed if CodeRabbit submitted a GitHub review on it, or if its summary
  says that a finished review covered it (`final_review_risk_coverage`).
- A summary that says "Review skipped" (a bot author, a draft) gives `⊘` with the reason.
  "Reviews paused" gives `‖`. The tool retries neither by itself: CodeRabbit chose not to review.
  Press `r` to ask once.
- The delay comes from the **current version** of the CodeRabbit comment.
  Its "available in …" starts at the last edit of the comment (`updated_at`).
- Only a **bare** `@coderabbitai review` comment counts as a request.
  If the comment has more text, CodeRabbit replies as a chat and starts no review.
- If a request has no reply after 15 min, it no longer blocks a retry.
- A review or a "Review triggered" reply after a rate limit lifts that rate limit.
- The quota belongs to the developer (the pull request author), on a rolling window. On the
  CodeRabbit "Open source" plan, it is also scoped per repository: the tool reads the "Plan:" line
  of the CodeRabbit comments and keeps such a repository on its own clock. The tool reads one
  quota clock from the CodeRabbit comments of all the listed pull requests in the same scope:
  - a notice with a delay ("Next included review available in …", in the first CodeRabbit
    comment, which CodeRabbit edits at each rate limit) gives the time when the quota comes back.
    The tool adds 30 s: CodeRabbit rounds its delays, and a request 4 s after the time can be refused;
  - a refused command with no delay ("Review rate limited.") only dates the refusal;
  - "N remain after this review" on a settled summary, after the refusal, means the quota is back.
    The tool dates it by the review, because a later edit of the summary can keep the line.
- When the time comes from another pull request, the details say so ("read on web#517 at 17:19").
- If a refusal came after the time that the newest notice gave, the tool assumes 1 hour.
- The tool only sees the pull requests that it lists. A review on a pull request outside the list
  spends the same quota, and the tool does not see it.
- The tool posts one request at a time, and polls for the reply to each one for about 90 s.
  A new rate limit puts the other pull requests on hold.

## Watch

- The tool searches the pull requests again once a minute. It adds the new ones, and shows the
  ones that are merged, closed or back to draft. It never posts on those. A draft that is ready for
  review again comes back into the watch.
- It reads each pull request again once a minute, and every 30 s while a reviewer reviews or a
  check runs.
- It reads each pull request with one GraphQL query of cost 1. Ten pull requests cost about
  600 points an hour, out of the 5,000 of the GraphQL limit. The REST limit, which `gh` commands
  of your agents use, stays free.
- All the runs of boo on this machine share a cache in `~/.cache/boo/` (or under
  `$XDG_CACHE_HOME`): a terminal watch, a scheduled run, the watch of an agent. A pull request that
  another run read less than 30 s ago costs no query. `r`, and the reads after a post or a merge,
  read GitHub, not the cache.
- If less than 20 % of the GraphQL points of the account remain, the header shows them
  (`GraphQL 312/5000 left, refresh every 5 min`), and the watch reads the list and each pull
  request every 5 minutes until GitHub resets the points. The runs share the count of points too.
