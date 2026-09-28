# boo

A terminal dashboard of your open pull requests: the approval, each reviewer (bot or person),
the checks, and the review quotas. It also retries CodeRabbit by itself after its quota comes back.

![boo --watch on simulated data](docs/demo.gif)

The pull requests that your agents open collect reviews from several bots. Some bots are out of
quota, some review in several passes, and some leave a red check that tells nothing about the code.
`boo` reads all of it for each pull request, and shows one line of state, one line of reviewers,
and the checks. It is the page <https://github.com/pulls/authored>, with the review state in it.

## Installation

```sh
git clone https://github.com/sakuga-software/coderabbit-retry.git boo
cd boo
pnpm install          # the prepare script builds dist/
ln -sf "$PWD/dist/cli.js" ~/.local/bin/boo
```

Requires Node 22 or later and an authenticated `gh` (`gh auth status`).

## Usage

```sh
boo                     # show the state once, retry CodeRabbit if its quota is back, then quit
boo --watch             # stay open until Ctrl+C, and refresh
boo --org all           # all organizations; the default organization is sakuga-software
boo --since 2026-09-15  # only the pull requests created on or after this date
boo --dry-run           # post and merge nothing
boo --help              # options, states and marks
```

## What a row shows

```
✔  ready to merge     web#921  feat(search): filter the results by date   ✔ 10/10 checks  2/2 on head · 2 reviews
                      last coderabbitai just now  ✔ coderabbitai  ✔ greptile
```

- **The state** of the pull request, from the first that applies: `conflicts`,
  `changes requested`, `checks failing`, `ready to merge`, `approved`, `reviewing`, `reviewed`,
  `quota`, `awaiting review`. A pull request that leaves the list shows `merged`, `closed` or
  `draft`.
- **The checks** of the last commit: passed, running or failing.
- **The reviewers** that reviewed the last commit, out of all the reviewers, and the count of reviews.
- **The last reviewer** and the age of their review.
- **One mark for each reviewer**: `✔` approved, `✎` changes requested, `●` commented on the last
  commit; `⟳` reviewing, with `2/3` if the bot shows its progress; `◷` out of quota, with the
  return time if the notice gives one; `↻` CodeRabbit to retry; `○` requested; `◌` reviewed an
  older commit only (`✔ old` if its approval still stands); `⊘` skipped; `‖` paused.

In a terminal, the selected row also shows its details: the names of the failing checks, the
protection rule that blocks the merge, and the quota return times.

## Rules

### Reviewers

- A reviewer is a person or a bot that submitted a review, that GitHub asks for a review, or
  CodeRabbit if it commented. The tool knows no list of bots, so a new reviewer needs no change.
  A bot that only comments, such as Linear or a preview deployment, is not a reviewer.
- The author of the pull request is not a reviewer: their reviews are replies in the threads.
- A review whose line comments all answer an earlier comment is a reply in a thread, not a
  review. A review with an empty body and its own line comments is a review: Greptile puts all its
  findings on the lines.
- A review that says `quota`, `rate limit`, `limit reached`, `unable to review` or `usage limit` in
  its first paragraph is a refusal, not a review. A real review can quote the quota of another
  reviewer further down, so the rest of the body does not count.
- A reviewer reviews now if it has a running check with its name (`claude-review` for
  `sakuga-claude-review[bot]`), or if its last review or comment shows a progress below its total
  (`2/3 files`).

### Approval and checks

- The approval follows the rule of GitHub: the last review of each reviewer that approves,
  requests changes or is dismissed stands, on any commit. One request for changes wins over all the
  approvals. A later comment review, such as a reply, does not replace a verdict.
- `ready to merge` needs an approval, no request for changes, no failing or running check, and a
  merge state that GitHub accepts (`clean`, `unstable` or `has_hooks`).
- A check counts as a quota check, and not as a failure, if its description names a quota
  (CodeRabbit: "Review rate limited"), or if it fails and belongs to a reviewer that refused for
  quota. A red check of a refused reviewer tells nothing about the code.

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

## Keys and mouse

With `--watch` in a terminal, the tool opens in full screen and takes keys and mouse clicks.
Piped or scheduled runs stay as they are.

| Key | Action |
| --- | --- |
| `↑` `↓` or `k` `j` | select a pull request (the mouse wheel does it too) |
| `o` or `Enter` | open the pull request in the browser |
| `m` | merge the pull request: squash if the repository allows it, else merge, else rebase |
| `h` | hide or show the merged, closed and draft pull requests |
| `r` | post `@coderabbitai review` |
| `f` | post `@coderabbitai full review` |
| `a` | post `@coderabbitai approve`: resolve the CodeRabbit threads, then approve |
| `s` | post `@coderabbitai resolve`: resolve the CodeRabbit threads |
| `q` | quit |

The CodeRabbit commands work only on a pull request that CodeRabbit comments on. Each post and
each merge asks for a confirmation: `y` or `Enter` confirms, `n` or `Esc` cancels. Before a merge,
the confirmation warns about a request for changes, a missing approval, a failing or running check,
a conflict, a protection rule or a branch behind its base. You can still merge: GitHub enforces the
protection rules anyway. The repository settings decide if GitHub deletes the branch. A post goes
through the same queue as the automatic retries. A click selects a row or presses a button of the
bar. The mouse mode takes over text selection: hold Shift or Option, depending on the terminal, to
select text. A merged or closed pull request accepts only `o`, and `--dry-run` disables every post
and every merge.

## Development

```sh
pnpm dev -- --dry-run   # run the sources with tsx
pnpm test               # tests of the decision logic
pnpm typecheck
```

## Demo

The GIF uses the real interface and the real decision logic with a fake GitHub
(`demo/demo.tsx`). The fake GitHub plays a timeline: a CodeRabbit review in progress, a bot that
shows its progress, a Copilot quota refusal, a CodeRabbit quota that comes back and a retry, a
merged pull request, a new pull request, then the reviews. At the end, it hides the merged pull
request with `h`, selects a pull request with the arrow keys, and posts `@coderabbitai approve`
with `a`, then `Enter`. To see it live, run `pnpm demo`. To record the GIF again (requires vhs, ttyd and ffmpeg):

```sh
demo/record.sh
```
