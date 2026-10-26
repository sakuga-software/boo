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
  "checks": { "passed": 8, "failing": ["Migrations"], "running": 0, "skipped": 1, "quota": 0 },
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
  }
}
```

| Key                      | Value                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                  | The words of the human output: `conflicts`, `changes requested`, `checks failing`, `ready to merge`, `approved`, `reviewing`, `reviewed`, `quota`, `awaiting review`. Also `merged`, `closed` or `draft` for a pull request that left the list, and `error` if GitHub did not answer (see `error`).        |
| `stalled`, `idleMinutes` | `stalled` is `true` for a stalled pull request (see [Stalled pull requests](../agents/#stalled-pull-requests)). `idleMinutes` gives the minutes since the commit time of the head commit, or `null`.                                                                                                       |
| `mergedBy`, `mergedAt`   | The login that merged the pull request (a GitHub App ends with `[bot]`), and the time of the merge. `null` if it is not merged.                                                                                                                                                                            |
| `headSha`, `base`        | The head commit and the base branch. `null` if GitHub did not answer.                                                                                                                                                                                                                                      |
| `checks`                 | The counts of the checks of the head commit, and the names of the checks that fail. `quota` counts the checks of a reviewer that refused for quota: they do not fail.                                                                                                                                      |
| `reviewers[].mark`       | `approved`, `changes requested`, `commented`, `reviewing`, `quota`, `to retry`, `requested`, `stale` (an older commit only), `skipped` or `paused`.                                                                                                                                                        |
| `reviewers[].onHead`     | `true` if the last review of the reviewer covers the head commit.                                                                                                                                                                                                                                          |
| `reviewers[].verdict`    | The verdict that stands over all the commits, or `null`.                                                                                                                                                                                                                                                   |
| `reviewers[].score`      | The last confidence score of the reviewer, or `null`.                                                                                                                                                                                                                                                      |
| `reviewers[].at`         | The time of the last review of the reviewer, or `null`.                                                                                                                                                                                                                                                    |
| `stack`                  | The listed pull request that this one merges into (`owner/repo#number`), its place from the bottom (`null` if the stack forks), and the size of the stack. `restack` is `{ "oldBase", "at" }` if the pull request needs a rebase after its parent merged (see [Stacks](../the-list/#stacks)), else `null`. |
| `agent.kind`             | `claude`, `copilot`, `codex`, `cursor`, `devin` or `null`. A local session makes it `claude`.                                                                                                                                                                                                              |
| `agent.subAgent`         | The sub-agent of the session that changed the pull request last, as `{ "id", "description", "state", "error" }`, or `null`. `state` is `working`, `done`, `failed` or `stopped`; `error` tells why a failed sub-agent stopped, for example `rate limit`. See [Sub-agents](../agents/#sub-agents).          |
| `agent.sessionState`     | `working`, `idle`, `waiting`, or `none` if no session on this machine linked the pull request.                                                                                                                                                                                                             |
| `notes.merge`            | The rule that blocks the merge, or `null`.                                                                                                                                                                                                                                                                 |
| `notes.retries`          | The retries of the review bots that a run without `--json` posts, with their times.                                                                                                                                                                                                                        |
| `notes.coderabbit`       | The CodeRabbit quota: `wait` with `availableAt`, `trigger`, `pending`, `skipped`, `paused`, `idle`, or `null`.                                                                                                                                                                                             |
| `policy`                 | The rules of the merge policy that the pull request misses, as `{ "rule", "note" }`: `minScore`, `requireProof`, `resolvedBotThreads`, `ownerOnly`, `answeredReviewRequests`. Empty with no policy.                                                                                                        |

The keys stay the same from one version to the next. A test fixes them.

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

| `event`    | When                                                                | Other keys                                                                                                             |
| ---------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `snapshot` | The first read, one line for each pull request                      | The keys of `--json`                                                                                                   |
| `entered`  | A pull request enters the list                                      | The keys of `--json`                                                                                                   |
| `state`    | The state changes                                                   | `from`, `to`, `failing`, and `error` with the message of GitHub if `to` is `error`                                     |
| `head`     | A new head commit                                                   | `from`, `to`                                                                                                           |
| `review`   | A reviewer has a new mark, verdict, score or review                 | `reviewer`, then the keys of `reviewers[]` in `--json`, with `reviewedAt` for `at`                                     |
| `check`    | A check starts to fail, or stops (it passed, or it runs again)      | `check`, `to`: `failing` or `not failing`                                                                              |
| `left`     | A pull request leaves the list                                      | `reason`: `merged`, `closed`, `draft`, or `unlisted` if it is still open; for `merged`, also `mergedBy` and `mergedAt` |
| `restack`  | GitHub moved the pull request to a new base after its parent merged | `oldBase`, `base`, `parent`: the pull request that it was stacked on, or `null` if it was not listed                   |
| `comment`  | A person writes a comment, a review or a line comment               | `author`, `createdAt`, `body` (the first 200 characters), `thread`: `true` for a line comment                          |

A `comment` event comes from a person, so that the agent of the pull request reads it at once. A
bot, the author of the pull request (an agent often posts as the author) and the logins of
`commentEvents.ignoreLogins` in the settings file give none. A comment that contains a marker of
`commentEvents.ignoreMarkers` gives none either: an agent can post with the account of a person, and
mark its replies. The first read of a pull request gives no `comment` event. The watch reads the text
of the line comments only with `--events`: the first 10 of each review.

```json
{ "commentEvents": { "ignoreLogins": ["my-agent-account"], "ignoreMarkers": ["<!-- claude-reply -->"] } }
```

GitHub fails one read now and then. A pull request goes to `error` only after two failed reads in a
row: until then it keeps its last state, and gives no event. Then its line says `"to":"error"`, with
the message of GitHub in `error`, and the next read that works says `"from":"error"`. A list that
GitHub does not give writes an error on stderr, and the watch goes on.
