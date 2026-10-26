---
title: Keys and mouse
description: The keys and the mouse of the full-screen watch.
---

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
