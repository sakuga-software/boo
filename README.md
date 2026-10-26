# boo

A terminal dashboard of your open pull requests: the approval, each reviewer (bot or person),
the checks, and the review quotas. It also retries CodeRabbit by itself after its quota comes back.

![boo --watch on simulated data](https://raw.githubusercontent.com/sakuga-software/boo/main/docs/demo.gif)

The pull requests that your agents open collect reviews from several bots. Some bots are out of
quota, some review in several passes, and some leave a red check that tells nothing about the code.
`boo` reads all of it for each pull request, and shows one line for each pull request, with its
details one key away. It is the page <https://github.com/pulls/authored>, with the review state in it,
for you and for the GitHub Apps that open pull requests for you.

## Installation

```sh
npm install --global @sakuga-software/boo
```

The package installs the `boo` command. To run the sources of a clone instead:

```sh
git clone https://github.com/sakuga-software/boo.git
cd boo
pnpm install          # the prepare script builds dist/
ln -sf "$PWD/dist/cli.js" ~/.local/bin/boo
```

Requires Node 22 or later and an authenticated `gh` (`gh auth status`). The Copilot review request
(`c`) needs `gh` 2.88 or later.

## Usage

```sh
boo                     # show the state once, retry CodeRabbit if its quota is back, then quit
boo --watch             # stay open until Ctrl+C, and refresh
boo --org all           # all organizations; the default organization is sakuga-software
boo --since 2026-09-15  # only the pull requests created on or after this date
boo --author @me --author app/my-agent  # the pull requests of these authors, for this run
boo --repo boo --repo acme/web  # only these repositories: owner/name, or name in the organization
boo --dry-run           # post and merge nothing
boo --json              # print the state as JSON for a script, and post nothing
boo --watch --events    # print each change as one JSON line, and post nothing
boo --help              # options, states and marks
```

## JSON output

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
  "stack": { "parent": null, "position": 1, "size": 2 },
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

| Key                      | Value                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                  | The words of the human output: `conflicts`, `changes requested`, `checks failing`, `ready to merge`, `approved`, `reviewing`, `reviewed`, `quota`, `awaiting review`. Also `merged`, `closed` or `draft` for a pull request that left the list, and `error` if GitHub did not answer (see `error`). |
| `stalled`, `idleMinutes` | `stalled` is `true` for a stalled pull request (see [Stalled pull requests](#stalled-pull-requests)). `idleMinutes` gives the minutes since the commit time of the head commit, or `null`.                                                                                                          |
| `mergedBy`, `mergedAt`   | The login that merged the pull request (a GitHub App ends with `[bot]`), and the time of the merge. `null` if it is not merged.                                                                                                                                                                     |
| `headSha`, `base`        | The head commit and the base branch. `null` if GitHub did not answer.                                                                                                                                                                                                                               |
| `checks`                 | The counts of the checks of the head commit, and the names of the checks that fail. `quota` counts the checks of a reviewer that refused for quota: they do not fail.                                                                                                                               |
| `reviewers[].mark`       | `approved`, `changes requested`, `commented`, `reviewing`, `quota`, `to retry`, `requested`, `stale` (an older commit only), `skipped` or `paused`.                                                                                                                                                 |
| `reviewers[].onHead`     | `true` if the last review of the reviewer covers the head commit.                                                                                                                                                                                                                                   |
| `reviewers[].verdict`    | The verdict that stands over all the commits, or `null`.                                                                                                                                                                                                                                            |
| `reviewers[].score`      | The last confidence score of the reviewer, or `null`.                                                                                                                                                                                                                                               |
| `reviewers[].at`         | The time of the last review of the reviewer, or `null`.                                                                                                                                                                                                                                             |
| `stack`                  | The listed pull request that this one merges into (`owner/repo#number`), its place from the bottom (`null` if the stack forks), and the size of the stack.                                                                                                                                          |
| `agent.kind`             | `claude`, `copilot`, `codex`, `cursor`, `devin` or `null`. A local session makes it `claude`.                                                                                                                                                                                                       |
| `agent.subAgent`         | The sub-agent of the session that changed the pull request last, as `{ "id", "description", "state", "error" }`, or `null`. `state` is `working`, `done`, `failed` or `stopped`; `error` tells why a failed sub-agent stopped, for example `rate limit`. See [Sub-agents](#sub-agents).             |
| `agent.sessionState`     | `working`, `idle`, `waiting`, or `none` if no session on this machine linked the pull request.                                                                                                                                                                                                      |
| `notes.merge`            | The rule that blocks the merge, or `null`.                                                                                                                                                                                                                                                          |
| `notes.retries`          | The retries of the review bots that a run without `--json` posts, with their times.                                                                                                                                                                                                                 |
| `notes.coderabbit`       | The CodeRabbit quota: `wait` with `availableAt`, `trigger`, `pending`, `skipped`, `paused`, `idle`, or `null`.                                                                                                                                                                                      |
| `policy`                 | The rules of the merge policy that the pull request misses, as `{ "rule", "note" }`: `minScore`, `requireProof`, `resolvedBotThreads`, `ownerOnly`, `answeredReviewRequests`. Empty with no policy.                                                                                                 |

The keys stay the same from one version to the next. A test fixes them.

### Events

`boo --watch --events` reads the list once a minute and prints each change as one JSON line
(NDJSON), so a script follows all the pull requests with no diff of its own. It posts nothing and
merges nothing. Each line has `at`, `pr` (`owner/repo#number`) and `event`:

```json
{"at":"…","pr":"acme/web#480","event":"state","from":"approved","to":"checks failing","failing":["Migrations"]}
{"at":"…","pr":"acme/web#480","event":"check","check":"Migrations","to":"failing"}
{"at":"…","pr":"acme/web#480","event":"review","reviewer":"sakuga-review[bot]","mark":"approved","onHead":true,"verdict":"approved","score":{"score":4,"total":5},"reviewedAt":"…"}
{"at":"…","pr":"acme/web#480","event":"left","reason":"merged","mergedBy":"octocat","mergedAt":"…"}
```

| `event`    | When                                                           | Other keys                                                                                                             |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `snapshot` | The first read, one line for each pull request                 | The keys of `--json`                                                                                                   |
| `entered`  | A pull request enters the list                                 | The keys of `--json`                                                                                                   |
| `state`    | The state changes                                              | `from`, `to`, `failing`, and `error` with the message of GitHub if `to` is `error`                                     |
| `head`     | A new head commit                                              | `from`, `to`                                                                                                           |
| `review`   | A reviewer has a new mark, verdict, score or review            | `reviewer`, then the keys of `reviewers[]` in `--json`, with `reviewedAt` for `at`                                     |
| `check`    | A check starts to fail, or stops (it passed, or it runs again) | `check`, `to`: `failing` or `not failing`                                                                              |
| `left`     | A pull request leaves the list                                 | `reason`: `merged`, `closed`, `draft`, or `unlisted` if it is still open; for `merged`, also `mergedBy` and `mergedAt` |

GitHub fails one read now and then. A pull request goes to `error` only after two failed reads in a
row: until then it keeps its last state, and gives no event. Then its line says `"to":"error"`, with
the message of GitHub in `error`, and the next read that works says `"from":"error"`. A list that
GitHub does not give writes an error on stderr, and the watch goes on.

## What a row shows

Each pull request takes one line. `e` or `→` unfolds it and shows its details; `e` or `←` folds it.
`Enter` opens it in the browser.

```
❯▾✎  changes requested  api#912  fix(auth): refresh the token before it expires   ✻ auth  ✔ 8/8 checks
                        changes    +384 −96 · 3 files

                        agent      ✻ Claude Code · session auth · working
                                   ~/code/api · a sends rebase, review, fix or test

                        reviewers  2/3 on head · 2 reviews · last greptile 9 min ago
                                   ✎ coderabbitai  changes requested · 10 min ago
                                   ◷ copilot       out of quota, no return time
                                   ● greptile      commented · confidence 2/5 · 9 min ago

                        checks     ✔ 8 passed

                        notes      blocked by the branch protection rules

  ✔  ready to merge     web#921  feat(search): filter the results by date   ◇ Copilot  ✔ 10/10 checks
```

The line of a pull request shows:

- **The state** of the pull request, from the first that applies: `conflicts`,
  `changes requested`, `checks failing`, `ready to merge`, `approved`, `reviewing`, `reviewed`,
  `quota`, `awaiting review`. A pull request that leaves the list shows `merged`, `closed` or
  `draft`. These three are hidden by default: `h` shows them.
- **The checks** of the last commit: passed, running or failing.
- **The place in the stack**, for a pull request that merges into another listed pull request.
- **The agent**: `✻` in the orange of Claude Code, with the name of its local session and of its
  sub-agent, `cloud` or `Claude`; `◇` and the name of another agent. A spinner replaces `✻` while
  the session works, and a yellow `?` follows a session that waits for an answer. See
  [Agents and local sessions](#agents-and-local-sessions).

An unfolded pull request shows its details in sections, one fact for each line, with a blank line
between two sections:

- **changes**: the lines added and removed, the count of changed files, and the age of the last
  commit.
- **merged**: for a merged pull request, the account that merged it and the age of the merge.
- **agent**: the agent, then the name, the sub-agent, the state and the folder of its local
  session, or the page of its cloud session.
- **reviewers**: the reviewers that reviewed the last commit out of all the reviewers, the count of
  reviews and the last reviewer. Then one line for each reviewer, with its mark, its state in words,
  its confidence score and the age of its last review. The confidence score comes from the last
  review or comment of the reviewer that gives one: `Confidence Score: 4/5` (Greptile) or
  `Score de confiance : 4/5` (Sakuga Review). It shows green from 80 %, yellow from 60 %, red below. The marks: `✔` approved, `✎` changes requested, `●` commented on
  the last commit; `⟳` reviewing, with `2/3` if the bot shows its progress; `◷` out of quota, with
  the return time if the notice gives one; `↻` CodeRabbit to retry; `○` requested; `◌` reviewed an
  older commit only, with the verdict that still stands; `⊘` skipped; `‖` paused.
- **checks**: the counts of the checks that passed, fail and run. Then one line for each failing
  check, with its cause (`fails here only`, or `fails on main too`), and one line for each check that
  a newer run replaces (`cancelled by a newer run`).
- **notes**: why the pull request is stalled, the protection rule that blocks the merge, the state
  of the pull request under it in a stack, the planned retries and the CodeRabbit quota.

### Stalled pull requests

A pull request can stay red for hours with no agent on it: the agent stopped, or it waits for an
answer. A yellow `zZ stalled` on the line marks a pull request with all these conditions:

- its state is `conflicts`, `checks failing` or `changes requested`;
- no local session works on it (a session that waits for an answer does not work). If a sub-agent
  of the session changed the pull request, the sub-agent must work on it, not the session;
- its head commit is older than `stalledAfterMinutes` in the settings file. The default is 30.

```json
{ "stalledAfterMinutes": 45 }
```

The commit time of the head commit counts, so a rebase or an amend starts the time again. A narrow
terminal shows `zZ` only.

A click on a row selects it, and a click on the selected row unfolds or folds it. A piped run shows
every pull request unfolded.

### Stacks

A pull request is stacked on another if it merges into the head branch of the other, in the same
repository. The list shows the stack under its bottom pull request, with a line that joins them.
All the pull requests above the bottom one have the same indent, at each height of the stack, and
each one comes after the pull request that it merges into:

```
✔  ready to merge     web#921  feat(a)                       stack of 3  ✔ 10/10 checks
├─ ⟳  reviewing          web#924  feat(b)                 on #921 · 2/3  ✔ 6/6 checks
└─ ◷  quota              web#930  feat(c)                 on #924 · 3/3  ◌ 2/8 running
```

- The bottom pull request shows the size of the stack. Each other one shows the pull request
  under it, and its place in the stack if the stack has no fork.
- A pull request whose base is not the default branch, but no listed pull request, shows that base:
  `on feat/x`.
- The details of a stacked pull request give the state of the pull request under it.
- Before you merge a stacked pull request, the confirmation warns that the merge lands in the
  branch under it, not in the default branch.
- If the pull request under it is hidden, such as a merged one, the stacked pull request shows as a
  root. `h` shows the tree again.
- A narrow terminal drops the text of the place in the stack, but it keeps the tree lines.

The ghost at the top left asks the terminal for its background color (OSC 11, or `COLORFGBG`) and
picks colors that read on it. A terminal that does not answer gets colors that read on both.

A narrow terminal shows less of each row, from the least useful part:

| Width             | The row drops                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| below 100 columns | the name of the state (the icon stays), the word "checks", the name after the mark of the agent, and the labels of the action bar |
| below 80 columns  | the last reviewer and the text of the place in the stack                                                                          |
| below 60 columns  | the checks                                                                                                                        |

### Agents and local sessions

```
❯▾✔  ready to merge     web#921  feat(search): filter the results by date   ✻ suricarte-mb-2  ✔ 10/10 checks
                        agent      ✻ Claude Code · session suricarte-mb-2 · idle
                                   ~/code/web · a sends rebase, review, fix or test
```

The tool reads the agent from the pull request: its author, its head branch, the authors and the
trailers of its last commit, and its description. It knows Claude Code, Copilot, Codex, Cursor and
Devin. A description that links a Claude Code cloud session shows `cloud session`. A pull request
that a person writes alone shows no agent.

Claude Code writes a link to each pull request that a session opens or looks at. The tool reads
these links in the sessions that run on this machine, every 5 seconds with `--watch`. If more than
one session links a pull request, the session with the last link works on it. The line of the
pull request then shows the name of the session, and its details show its state: `working` (it
answers or runs a command), `idle`, or `waiting` with what it waits for.

`a` opens the commands for the agent. Each command sends a prompt to the local session of the
pull request:

| Key | Command  | Prompt                                                                          |
| --- | -------- | ------------------------------------------------------------------------------- |
| `b` | `rebase` | rebase the head branch on its base, resolve the conflicts, and push             |
| `r` | `review` | read the diff, and report each bug and each risk with its file and line         |
| `f` | `fix`    | fix the valid review comments and the failing checks, push, and answer each one |
| `t` | `test`   | test the change from end to end, and report what works and what fails           |

The session reads the prompt after its current turn, as a message from another session named
`boo`. Claude Code does not run a slash command that comes this way, so a prompt is plain text.
The commands reach only a session on this machine: a session on another machine or in the cloud
shows its agent, but the bar dims the commands. If the description of the pull request links a
cloud session, `w` (`open online`) opens its page in the browser, with no confirmation.

> [!WARNING]
> The session records, the links and the inbox of a session are internal to Claude Code, not a
> public interface. A new version of Claude Code can change them. Then the rows show no local
> session, or a command fails with an error in the bar.

The settings file can replace the prompt of a command, by its name. `{url}`, `{branch}` and
`{base}` take the values of the pull request:

```json
{ "agentPrompts": { "fix": "Apply the review comments of {url}, then push." } }
```

#### Sub-agents

```
❯▾✖  checks failing     web#924  fix(search): keep the filter   ✻ orchestra › Fix the search filter ✖
                        agent      ✻ Claude Code · session orchestra › sub-agent Fix the search filter · failed: rate limit
                                   ~/code/web · session working · a sends rebase, review, fix or test
```

A session can give its work to sub-agents, and each sub-agent can open its own pull requests.
Claude Code writes the link of such a pull request in the transcript of the session, not in the
transcript of the sub-agent. The tool finds the sub-agent from its own transcript: the output of a
`gh pr create`, `edit`, `comment`, `ready`, `merge` or `review` command gives the URL of the pull
request. If more than one sub-agent changed a pull request, the last one shows. The line shows the
task that the session gave to the sub-agent, after the name of the session, or the id of the
sub-agent if the task is not known. The commands of `a` go to the session.

The state of the sub-agent comes from the last message of its transcript:

- `done`: its last reply ends its turn;
- `failed`: Claude Code stopped it with an error, for example `rate limit`. A red `✖` follows its
  name on the line;
- `stopped`: a person interrupted it;
- `working`: anything else. The spinner shows on the line. If the last message waits for the next
  part of the reply (the output of a tool, or a message to the sub-agent) for more than 10 minutes,
  the sub-agent is `done`: a sub-agent that ended does not answer a message that comes after its end.

The details show the state of the sub-agent on the first line, and the state of the session on the
second line.

## Settings

Press `,` to open the settings. `↑` `↓` choose a line, `Space` or `Enter` changes it, `,` or `Esc`
closes the panel. The tool saves them in `~/.config/boo/settings.json` (or under
`$XDG_CONFIG_HOME`).

- Hide the merged, the closed and the draft pull requests, each on its own. All three are on.
- Show the checks, the reviewers on head and the review count, the last reviewer, the mark of each
  reviewer, the agent and the local session, and the other details of an unfolded pull request. A
  narrow terminal can still hide them.
- Compact rows: no blank line between the pull requests.
- Show each stacked pull request under the pull request that it merges into. It is on. Off, the list
  keeps its order, but the details and the merge confirmation still name the pull request under it.

- The authors of the listed pull requests. `Space` or `Enter` on this line starts the change: type
  the authors with a comma between two, then `Enter` saves and `Esc` cancels. The list follows the
  new authors at once.

An author is a login, `@me` (the account of `gh`), or `app/<slug>` for a GitHub App. The default is
`@me`. `--author` replaces the list at the start of one run. The file holds the authors as a list:

```json
{ "authors": ["@me", "app/my-agent"] }
```

The key `repos` limits the list to some repositories. A repository is `owner/name`, or `name` in the
organization of `--org`. With no `repos`, the tool lists every repository of the organization.
`--repo` replaces the list at the start of one run. A repository of another owner counts too.

```json
{ "repos": ["boo", "acme/web"] }
```

### Review bots

The settings list the review bots of the action bar, with their key, the way the tool asks them, and
their logins.

- `Space` or `Enter` turns a bot on or off. A bot that is off leaves the list of the review bots, and
  CodeRabbit gets no more automatic retries. The tool still shows the bot as a reviewer.
- `a` turns the automatic retry of a bot on or off. It is on for CodeRabbit only. See
  [Retries of the other bots](#retries-of-the-other-bots).
- `+ add a review bot` opens a form of five fields. `Enter` goes to the next field, `Esc` cancels:
  1. the name that the bar shows;
  2. the key that opens its menu: one letter or one digit that no other bot and no other action uses;
  3. its GitHub logins, with a comma between two, such as `sourcery-ai[bot]`. The bar dims the bot
     on a pull request where no reviewer has one of these logins;
  4. the way to ask it: `@mention` posts `@mention <command>`, `/` posts `/<command>`, and a login
     asks GitHub for a review by that login (`gh pr edit --add-reviewer`). A review request has no
     command, so the form stops there;
  5. its commands, with a comma between two. The first one asks for a review: the automatic retry
     posts it. Each command takes the first free letter of its name as its key.
- `d` deletes a bot that you added. A known bot can only be turned off.

The file holds the switches by bot, and the bots that you added:

```json
{
  "bots": { "greptile": { "enabled": false }, "copilot": { "autoRetry": true } },
  "customBots": [
    {
      "name": "Sourcery",
      "key": "s",
      "logins": ["sourcery-ai[bot]"],
      "mention": "@sourcery-ai",
      "commands": ["review", "summary"]
    }
  ]
}
```

## Rules

### Reviewers

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

### PR-Agent

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

### Approval and checks

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
- Each failing check shows its cause in the details: `✖ Migrations · fails on main too` if the same
  check fails on the last commit of the base branch, else `✖ Migrations · fails here only`. A check
  that fails on the base branch too still counts as failing: the pull request cannot merge green.

### Merge policy

"Ready to merge" means approved, green and mergeable for GitHub. A team can add its own rules in
`mergePolicy` in the settings file. A pull request that misses a rule shows `approved`, not
`ready to merge`, and its details give a note for each rule: `merge policy: no proof`. `m` refuses
to merge it and names the rules. `--json` gives the misses in `policy`.

```json
{
  "mergePolicy": {
    "minScore": { "reviewer": "sakuga-review", "score": 4, "onHead": true },
    "requireProof": "\\.(gif|webm|mp4)|No /tfp:",
    "resolvedBotThreads": true,
    "ownerOnly": { "paths": [".github/workflows/**", "**/migrations/**", "**/auth/**"], "owner": "mathieu" },
    "answeredReviewRequests": true
  }
}
```

| Rule                     | The pull request needs                                                                                                                                                                                                                                                                                                                                                                                  | Note                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `minScore`               | A last confidence score of `reviewer` of at least `score`. With `onHead`, the score must come from a review of the head commit; a comment, such as the summary of Greptile, has no commit.                                                                                                                                                                                                              | `no score from sakuga-review`, `no score from sakuga-review on head`, `score 3/5 on head, 4 needed` |
| `requireProof`           | A match of this regular expression (case insensitive) in the description or in a comment: a link to a recording, or a reason with no test.                                                                                                                                                                                                                                                              | `no proof`                                                                                          |
| `resolvedBotThreads`     | No unresolved review thread that a bot starts (the first 100 threads).                                                                                                                                                                                                                                                                                                                                  | `2 open bot threads`                                                                                |
| `ownerOnly`              | If the pull request changes a file under one of `paths` (globs: `*` in a name, `**` for any folders), only `owner` merges it. The query reads the first 100 files: with more, only `owner` merges. `@me` is the account of `gh`, so a shared file names the owner by login.                                                                                                                             | `mathieu merges`                                                                                    |
| `answeredReviewRequests` | An answer of each bot that a comment asked for a review after its last review: a line that starts with the mention of the bot and contains the word `review`, such as `@sakuga-review review balanced`. A thank you to the bot is not a request. A review of that bot after the comment answers it. The comment of the bot itself does not count, but the comment of an agent that posts as a bot does. | `review asked of sakuga-review, no answer yet`                                                      |

A rule with a missing or invalid field is dropped. `resolvedBotThreads` and `ownerOnly` make each
query read the threads or the files, and cost about one GraphQL point more for each pull request.

### Retries of the other bots

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

### CodeRabbit retries

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

### Watch

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

## Keys and mouse

With `--watch` in a terminal, the tool opens in full screen and takes keys and mouse clicks. The
counts and the action bar stay at the bottom of the window. Piped or scheduled runs stay as they are.

The action bar has three levels. The main set shows open, merge, refresh, the hidden pull requests,
the commands for the agent and the settings. `b` or `Space` shows the list of the review bots. `a`
shows the commands for the agent. The key of a bot opens the menu of that bot, with its commands.
`←` or `Space` goes back one level, and `Esc` goes back to the main set. In the main set, `→` and
`←` unfold and fold the selected pull request.

A key of a bot or of a command works only at the level that shows it, so two bots can use the same
key. The keys of the main set work at every level, except `r`: in the bot levels, `r` belongs to the
bots.

| Key                | Action                                                                              |
| ------------------ | ----------------------------------------------------------------------------------- |
| `↑` `↓` or `k` `j` | select a pull request (the mouse wheel does it too)                                 |
| `Enter` or `o`     | open the pull request in the browser                                                |
| `e`                | unfold or fold the selected pull request, in the main set only                      |
| `→`                | unfold the selected pull request                                                    |
| `←`                | fold the selected pull request; in another level, go back one level                 |
| `m`                | merge the pull request: squash if the repository allows it, else merge, else rebase |
| `r`                | read the list and every pull request again now, in the main set only                |
| `h`                | show or hide the merged, closed and draft pull requests                             |
| `a`                | show the commands for the agent, in the main set only                               |
| `,`                | open the settings                                                                   |
| `b` or `Space`     | show the list of the review bots; `Space` goes back one level in another level      |
| `Esc`              | go back to the main set                                                             |
| `q`                | quit                                                                                |

In the list of the review bots:

| Key | Menu       | Commands                                                                                                                                                                                                                      |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `r` | CodeRabbit | `r` posts `@coderabbitai review`, `f` posts `@coderabbitai full review`, `a` posts `@coderabbitai approve` (resolve the CodeRabbit threads, then approve), `s` posts `@coderabbitai resolve` (resolve the CodeRabbit threads) |
| `g` | Greptile   | `r` posts `@greptileai review`                                                                                                                                                                                                |
| `c` | Copilot    | `r` asks Copilot for a review (`gh pr edit --add-reviewer @copilot`, needs `gh` 2.88 or later)                                                                                                                                |
| `p` | PR-Agent   | `r` posts `/review` (PR-Agent reviews the pull request again), `i` posts `/improve` (PR-Agent suggests code changes on the lines)                                                                                             |

A command to a bot that takes its commands in a comment, such as CodeRabbit, Greptile or PR-Agent,
works only on a pull request that the bot reviews; the bar dims the bot and its commands on the other ones. Copilot gets a review request from GitHub and not a comment: a mention of
`@copilot` starts its coding agent. The detection of the reviewers keeps no list of bots, but the
list of the review bots does: only these four bots, and the bots that you add in the settings, have a
known command. A CodeRabbit post goes through the queue
of the automatic retries. A post to another bot goes at once, because it does not spend the
CodeRabbit quota.

Each post, each command for the agent and each merge asks for a confirmation: `y` or `Enter` confirms, `n` or `Esc` cancels. Before a merge,
the confirmation warns about a request for changes, a missing approval, a failing or running check,
a conflict, a protection rule, a branch behind its base, or a base that is not the default branch
(a stacked pull request). You can still merge: GitHub enforces the
protection rules anyway. The repository settings decide if GitHub deletes the branch. A click
selects a row, presses a button of the bar, or changes a line of the settings. The mouse mode takes over text selection: hold Shift or Option, depending on the terminal, to
select text. A merged or closed pull request accepts only `o`, and `--dry-run` disables every post,
every command for the agent and every merge.

## Development

```sh
pnpm dev -- --dry-run   # run the sources with tsx
pnpm test               # the tests, with the dashboard rendered by ink-testing-library
pnpm test:coverage      # the tests, and the coverage that CI asks for
pnpm typecheck          # the sources, the tests and the demo
pnpm lint               # oxlint, a warning fails
pnpm format             # oxfmt --check; pnpm format:fix writes the files
pnpm check:pack         # pack the package, install it in an empty folder and run boo
pnpm check              # all of the above, as CI runs them
```

`pnpm install` installs two git hooks (husky). `pre-commit` checks the format and the lint of the
staged files. `pre-push` runs the typecheck and the tests. CI is the gate: `--no-verify` skips a
hook, not CI. CI also runs the tests on Node 22, the oldest version that `engines` accepts, and
checks that the title of a pull request follows the convention of the commits.

### Release

A GitHub release publishes the package on npm (`.github/workflows/publish.yml`):

1. In a pull request, change `version` in `package.json` (`npm version minor --no-git-tag-version`),
   then merge it.
2. Optional: run the workflow by hand on `main` (Actions → Publish → Run workflow). It does all the
   checks and shows what npm would publish, with no publish.
3. Create a release on `main` with the tag `v` + that version, for example `v1.2.0`.

The workflow refuses a tag that does not match the version, and a version that is already on npm.
A first job runs the checks and packs the tarball, with no right to publish. A second job publishes
that tarball with npm trusted publishing: npm trusts the OIDC token of the workflow, so the
repository keeps no npm token, and the package gets a signed provenance. The second job installs
nothing, so no script of a dependency runs next to that token.

## Demo

The GIF uses the real interface and the real decision logic with a fake GitHub
(`demo/demo.tsx`). The fake GitHub plays a timeline: a CodeRabbit review in progress, a bot that
shows its progress, a Copilot quota refusal, a CodeRabbit quota that comes back and a retry, a
merged pull request, a new pull request, then the reviews. At the end, it unfolds the first pull
request with `e`, selects another one and unfolds it with `→`, shows the list of the review bots with `b`,
opens the CodeRabbit menu with `r`, and posts
`@coderabbitai approve` with `a`, then `Enter`. Then it goes back to the first pull request, which a
fake local session works on, opens the commands for the agent with `a`, and sends `fix` with `f`,
then `Enter`. To see it live, run `pnpm demo`. To record the GIF again (requires vhs, ttyd and ffmpeg):

```sh
demo/record.sh
```
