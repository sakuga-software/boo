---
title: Agents and sessions
description: How boo finds the coding agent of a pull request, its local Claude Code session and its sub-agents, and sends them commands.
---

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

:::caution
The session records, the links and the inbox of a session are internal to Claude Code, not a
public interface. A new version of Claude Code can change them. Then the rows show no local
session, or a command fails with an error in the bar.
:::

The settings file can replace the prompt of a command, by its name. `{url}`, `{branch}` and
`{base}` take the values of the pull request:

```json
{ "agentPrompts": { "fix": "Apply the review comments of {url}, then push." } }
```

## Sub-agents

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

## Stalled pull requests

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
