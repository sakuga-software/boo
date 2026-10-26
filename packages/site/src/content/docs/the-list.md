---
title: The list
description: What a row shows, the details of an unfolded pull request, the stacks and the narrow terminals.
---

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
  [Agents and local sessions](../agents/).

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

## Stacks

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
- After the pull request under it merges and GitHub deletes its branch, GitHub moves the stacked
  pull request to the next base. A squash merge leaves the commits of the merged pull request in
  the stacked one, so it shows `parent merged · rebase`, with the old base in the details, until a
  new commit comes (`git rebase --onto <base> <old base>`). GitHub tells this move as an event of
  the pull request, so the check needs no history: `--json` gives it too.
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
