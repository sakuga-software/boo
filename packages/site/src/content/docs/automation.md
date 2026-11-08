---
title: Scripts and orchestrators
description: The JSON output and the event stream, for a script or an agent that follows the pull requests.
---

`boo --json` prints one JSON array, with one object for each pull request, in the order of the list.
It posts nothing and merges nothing. It has no colors, no spinner and no width limit, so a script
needs no `COLUMNS` and no clean-up. For a stream of changes, use `--watch --events`.

```json
{
  "repo": "acme/web",
  "number": 921,
  "title": "feat(search): filter the results by date",
  "url": "https://github.com/acme/web/pull/921",
  "headSha": "4f1c2e…",
  "base": "main",
  "isDraft": false,
  "state": "checks failing",
  "stalled": false,
  "idleMinutes": 12,
  "mergedBy": null,
  "mergedAt": null,
  "error": null,
  "checks": { "passed": 8, "failing": ["Migrations"], "running": 0, "skipped": 1, "quota": 0, "reviewerErrors": [] },
  "reviewers": [
    {
      "login": "greptile-apps[bot]",
      "mark": "commented",
      "onHead": true,
      "verdict": "commented",
      "score": { "score": 4, "total": 5 },
      "at": "2026-10-24T09:12:00.000Z"
    }
  ],
  "stack": { "parent": null, "position": 1, "size": 2, "restack": null },
  "agent": {
    "kind": "claude",
    "session": "web-2",
    "subAgent": {
      "id": "a0e40d0b237c6058e",
      "description": "Fix the search filter",
      "state": "working",
      "error": null
    },
    "sessionState": "working",
    "cloudSession": null
  },
  "notes": {
    "merge": "blocked by the branch protection rules",
    "retries": [{ "bot": "Copilot", "at": "2026-10-24T10:00:00.000Z" }],
    "coderabbit": null
  },
  "policy": [{ "rule": "resolvedBotThreads", "note": "1 answered bot thread to resolve" }],
  "stale": null,
  "findings": {
    "count": 1,
    "answered": 1,
    "levels": { "P2": { "count": 1, "answered": 1 } },
    "places": {
      "thread": { "count": 1, "answered": 1 },
      "review": { "count": 0, "answered": 0 },
      "description": { "count": 0, "answered": 0 }
    },
    "unanswered": [],
    "threadsRead": true
  },
  "threads": { "open": 0, "answered": 1 }
}
```

| Key                           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                       | The words of the human output: `conflicts`, `changes requested`, `checks failing`, `reviewer error`, `ready to merge`, `approved`, `reviewing`, `reviewed`, `quota`, `awaiting review`. Also `merged`, `closed` or `draft` for a pull request that left the list, and `error` if GitHub did not answer (see `error`).                                                                                                                                                                                                                             |
| `stalled`, `idleMinutes`      | `stalled` is `true` for a stalled pull request (see [Stalled pull requests](../agents/#stalled-pull-requests)). `idleMinutes` gives the minutes since the commit time of the head commit, or `null`.                                                                                                                                                                                                                                                                                                                                              |
| `mergedBy`, `mergedAt`        | The login that merged the pull request (a GitHub App ends with `[bot]`), and the time of the merge. `null` if it is not merged.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `headSha`, `base`             | The head commit and the base branch. `null` if GitHub did not answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `checks`                      | The counts of the checks of the head commit, and the names of the checks that fail. `quota` counts the checks of a reviewer that refused for quota: they do not fail. `reviewerErrors` lists the red checks of `reviewerChecks` as `{ "check", "error" }`, with the first error line of the log or `null`; they stay in `failing`.                                                                                                                                                                                                                |
| `reviewers[].mark`            | `approved`, `changes requested`, `commented`, `reviewing`, `quota`, `to retry`, `requested`, `stale` (an older commit only), `skipped` or `paused`.                                                                                                                                                                                                                                                                                                                                                                                               |
| `reviewers[].onHead`          | `true` if the last review of the reviewer covers the head commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `reviewers[].verdict`         | The verdict that stands over all the commits, or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `reviewers[].score`           | The last confidence score of the reviewer, or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `reviewers[].at`              | The time of the last review of the reviewer, or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `stack`                       | The listed pull request that this one merges into (`owner/repo#number`), its place from the bottom (`null` if the stack forks), and the size of the stack. `restack` is `{ "oldBase", "at" }` if the pull request needs a rebase after its parent merged (see [Stacks](../the-list/#stacks)), else `null`.                                                                                                                                                                                                                                        |
| `agent.kind`                  | `claude`, `copilot`, `codex`, `cursor`, `devin` or `null`. A local session makes it `claude`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `agent.subAgent`              | The sub-agent of the session that changed the pull request last, as `{ "id", "description", "state", "error" }`, or `null`. `state` is `working`, `done`, `failed` or `stopped`; `error` tells why a failed sub-agent stopped, for example `rate limit`. See [Sub-agents](../agents/#sub-agents).                                                                                                                                                                                                                                                 |
| `agent.sessionState`          | `working`, `idle`, `waiting`, or `none` if no session on this machine linked the pull request.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `notes.merge`                 | The rule that blocks the merge, or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `notes.retries`               | The retries of the review bots that a run without `--json` posts, with their times.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `notes.coderabbit`            | The CodeRabbit quota: `wait` with `availableAt`, `trigger`, `pending`, `skipped`, `paused`, `idle`, or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `stale`                       | `{ "at", "until" }` if GitHub refused the query for a rate limit: the other keys then give the last read that worked, at `at`, and `until` is the time that GitHub answers again (or `null`). `null` for a read of now. See [Quotas and retries](../quotas/).                                                                                                                                                                                                                                                                                     |
| `findings`                    | The findings of the review bots, with a level badge (`P1`, `P2`…): `count` and `answered`, then the same counts by level in `levels` and by place in `places` (`thread`, `review`, `description`), and `unanswered`, a list of `{ "level", "place", "title", "id" }`. `threadsRead` is `false` if the read did not read the threads: `places.thread` then knows nothing. See [`answerFindings`](../merge-policy/) for what a finding and an answer are. The threads count only if the read reads them (`resolvedBotThreads` or `answerFindings`). |
| `threads`                     | The unresolved review threads that a bot started, as `{ "open", "answered" }`: `open` has no answer; `answered` ends with a reply of the author or of an agent of `authors`, and waits for a person to resolve it. A thread that the bot marks gone does not count. `null` if the read did not read the threads (`resolvedBotThreads` or `answerFindings`).                                                                                                                                                                                       |
| `needsOwner`, `readyForOwner` | `needsOwner` is `{ "owner", "paths", "partial" }` when the pull request changes files of [`ownerOnly`](../merge-policy/): the owner, the owned files among the first 100, and `partial: true` if the pull request has more files than the query read. `null` otherwise, or with no `ownerOnly`. `readyForOwner` is `true` when the pull request is green, approved, mergeable, and passes every rule of the policy but `ownerOnly`: only the owner can merge it now.                                                                              |
| `policy`                      | The rules of the merge policy that the pull request misses, as `{ "rule", "note" }`: `minScore`, `requireProof`, `resolvedBotThreads`, `ownerOnly`, `answeredReviewRequests`, `answerFindings`. Empty with no policy.                                                                                                                                                                                                                                                                                                                             |

The keys stay the same from one version to the next. A test fixes them.

## One pull request

`boo --json --pr fruitback#641` reads only that pull request, with no search: `owner/repo#123`,
`repo#123` in the organization of `--org`, or its URL. Repeat `--pr` for more. The output is the
same list, with one object for each named pull request, and the read uses the shared cache. A script
that just got an event reads the whole picture this way, with the same answers as the list.

```sh
boo --json --pr fruitback#641 | jq '.[0] | {state, checks, policy}'
```

## Events

`boo --watch --events` reads the list once a minute and prints each change as one JSON line
(NDJSON), so a script follows all the pull requests with no diff of its own. It posts nothing and
merges nothing. Each line has `at`, `pr` (`owner/repo#number`) and `event`:

```json
{"at":"…","pr":"acme/web#480","event":"state","from":"approved","to":"checks failing","failing":["Migrations"]}
{"at":"…","pr":"acme/web#480","event":"check","check":"Migrations","to":"failing"}
{"at":"…","pr":"acme/web#480","event":"review","reviewer":"sakuga-review[bot]","mark":"approved","onHead":true,"verdict":"approved","score":{"score":4,"total":5},"reviewedAt":"…"}
{"at":"…","pr":"acme/web#480","event":"left","reason":"merged","mergedBy":"octocat","mergedAt":"…"}
```

| `event`           | When                                                                                                                                        | Other keys                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`        | The first read, one line for each pull request                                                                                              | The keys of `--json`                                                                                                                                                                                                                   |
| `entered`         | A pull request enters the list                                                                                                              | The keys of `--json`                                                                                                                                                                                                                   |
| `state`           | The state changes                                                                                                                           | `from`, `to`, `failing`, and `error` with the message of GitHub if `to` is `error`                                                                                                                                                     |
| `head`            | A new head commit                                                                                                                           | `from`, `to`                                                                                                                                                                                                                           |
| `review`          | A reviewer has a new mark, verdict, score or review                                                                                         | `reviewer`, then the keys of `reviewers[]` in `--json`, with `reviewedAt` for `at`                                                                                                                                                     |
| `check`           | A check starts to fail, or stops (it passed, or it runs again)                                                                              | `check`, `to`: `failing` or `not failing`; `reviewerError: true` and `error` for a check of `reviewerChecks`                                                                                                                           |
| `left`            | A pull request leaves the list                                                                                                              | `reason`: `merged`, `closed`, `draft`, or `unlisted` if it is still open; for `merged`, also `mergedBy` and `mergedAt`; for a merge of a pull request with owner paths, also `ownerPaths` and `byOwner` (`null` if the owner is `@me`) |
| `restack`         | GitHub moved the pull request to a new base after its parent merged                                                                         | `oldBase`, `base`, `parent`: the pull request that it was stacked on, or `null` if it was not listed                                                                                                                                   |
| `ready-for-owner` | The pull request starts to wait only for the owner of its files (`readyForOwner` turns `true`): one event, not one at each read             | `owner`, `paths`, `partial`                                                                                                                                                                                                            |
| `owner-bypass`    | A pull request with owner paths merged, and the account that merged it is not the owner, such as an agent: one line after its `left`        | `owner`, `mergedBy`, `paths`, `partial`, `mergedAt`                                                                                                                                                                                    |
| `policy`          | The pull request starts or stops to miss a rule of the merge policy, or a note changes, such as `2 open bot threads` to `1 open bot thread` | `policy`: all the misses now, as in `--json`; `added` and `removed`: the notes that came and went                                                                                                                                      |
| `comment`         | A person writes a comment, a review or a line comment                                                                                       | `author`, `createdAt`, `body` (the first 200 characters), `thread`: `true` for a line comment                                                                                                                                          |
| `review-request`  | A comment asks a bot for a review, or that request has a new outcome                                                                        | `bot`, `author`, `createdAt`, `body`, `outcome`: `asked`, `acknowledged`, `failed`, `answered` or `stale`; `reason` for `failed`                                                                                                       |
| `findings`        | The findings or their answers change                                                                                                        | The keys of `findings` in `--json`                                                                                                                                                                                                     |

A `comment` event comes from a person, so that the agent of the pull request reads it at once. A
bot, the author of the pull request (an agent often posts as the author) and the logins of
`commentEvents.ignoreLogins` in the settings file give none. A comment that contains a marker of
`commentEvents.ignoreMarkers` gives none either: an agent can post with the account of a person, and
mark its replies. The first read of a pull request gives no `comment` event. The watch reads the text
of the line comments only with `--events`: the first 10 of each review.

```json
{ "commentEvents": { "ignoreLogins": ["my-agent-account"], "ignoreMarkers": ["<!-- claude-reply -->"] } }
```

A comment that asks a bot for a review, such as `@coderabbitai review` or `@kento-review heavy`,
is a command, not a remark: it gives `review-request` events, and no `comment` event. The request
follows the rules of [`answeredReviewRequests`](../merge-policy/), with the logins and the commands
of `minScore`. Its `outcome` is the first that applies:

- `answered`: a review of the bot came after the comment, and before the next request to the same
  bot;
- `failed`: the bot put 😕 on the comment, or posted a failure notice after it and before the next
  request to the same bot: a comment whose first line says `review en échec`, `review failed`,
  `unable to review`, `quota`, `usage limit` or `rate limit`. A notice that names another level than the request (`lite` for a `balanced` request) is for another review. `reason` gives the cause: the line
  that starts with `Raison`, `Reason`, `Cause` or `Error`, else the first paragraph;
- `acknowledged`: the bot put 👀 on the comment (the read gives the first 50 reactors of each reaction; with more, the reaction counts);
- `stale`: no 👀, no 😕 and no review after `reviewRequestTimeoutMinutes` (15 by default);
- `asked`: none of these yet.

The first read of a pull request gives no `review-request` event. Then each request gives one event
when it comes, and one more each time its outcome changes:

```json
{
  "at": "…",
  "pr": "acme/web#864",
  "event": "review-request",
  "bot": "kento-review",
  "author": "octocat",
  "createdAt": "…",
  "body": "@kento-review balanced",
  "outcome": "failed",
  "reason": "Raison : no model gave a usable answer: … You have reached your specified API usage limits."
}
```

A watch that starts again reads every pull request again: with no saved state, its first read gives a
`snapshot` line for each one, and a script that relays the events sees the old reviews and checks
again. `--state <file>` keeps the last state of the watch in that file: the last data of each pull
request, the comments and the review requests that it knows. At the start, the watch reads the file
and gives only the changes since that state: a review, a check or a comment of the time when no watch
ran, a pull request that merged then (`left`), and nothing for the rest. `--snapshot` adds one
`snapshot` line for each pull request at the start, so that a script can rebuild its view. A missing
file, a broken file or a file of another version of the state gives a start with `snapshot` lines,
as with no `--state`. The watch writes the file after each read, in one step (a write, then a rename).

```sh
boo --watch --events --state ~/.cache/boo-watch-state.json
```

GitHub fails one read now and then. A pull request goes to `error` only after two failed reads in a
row: until then it keeps its last state, and gives no event. Then its line says `"to":"error"`, with
the message of GitHub in `error`, and the next read that works says `"from":"error"`. A list that
GitHub does not give writes an error on stderr, and the watch goes on.
