# boo

The control tower for the pull requests of your coding agents.

![boo --watch on simulated data](https://raw.githubusercontent.com/sakuga-software/boo/main/docs/demo.gif)

Your agents open the pull requests: Claude Code sessions and their sub-agents, Copilot, Codex, a
GitHub App of your own. Review bots answer them, some in several passes, some out of quota, some
with a red check that tells nothing about the code. `boo` reads all of it and shows one line for
each pull request: its state, its checks, each reviewer, and the agent that works on it. A person
reads the list in a terminal. An orchestrator reads the same state as JSON.

**Documentation: <https://sakuga-software.github.io/boo/>**

## What it does for agents

- **It knows the agent of each pull request.** It reads the agent from the author, the branch, the
  commits and the description. A Claude Code session on this machine that linked the pull request
  shows its name and its state: working, idle, or waiting for an answer. If a sub-agent of the
  session opened the pull request, its task shows too, with its state: working, done, or failed
  with its error. [Agents and sessions](https://sakuga-software.github.io/boo/agents/)
- **It talks to the agent.** `a` sends a prompt to the session that owns the pull request: rebase,
  review, fix or test. The session reads it after its current turn.
- **It feeds your orchestrator.** `boo --json` prints the state of each pull request, with keys that
  stay the same from one version to the next. `boo --watch --events` streams each change as one
  line of NDJSON: a state, a review, a check, a comment of a person that the agent must read, a
  merge and who did it, a stacked pull request to rebase.
  [Scripts and orchestrators](https://sakuga-software.github.io/boo/automation/)
- **It guards the merge.** A merge policy keeps a pull request out of `ready to merge` until the
  rules of the team pass: a minimum score from the deepest review, a proof, resolved bot threads, an
  answer to a review that was asked for, files that only their owner merges.
  [Merge policy](https://sakuga-software.github.io/boo/merge-policy/)
- **It spots the work that stopped.** A red pull request with no agent at work and no new commit is
  `stalled`. A stacked pull request whose parent merged shows `parent merged · rebase`.

And for every pull request, agent or not: each reviewer with its mark and its confidence score, a
quota refusal that is not a review, a red check that does not count, a CI run that is still queued,
and a CodeRabbit retry when its quota comes back.

## Installation

```sh
npm install --global @sakuga-software/boo
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

> [!WARNING]
> The session records of Claude Code, its links to the pull requests and the inbox of a session
> are internal to Claude Code, not a public interface. A new version of Claude Code can change
> them. Then the rows show no local session, or a command fails with an error in the bar.

## Documentation

- [Get started](https://sakuga-software.github.io/boo/getting-started/)
- [Agents and sessions](https://sakuga-software.github.io/boo/agents/): the agent, the session and
  the sub-agent of a pull request, the commands, the stalled pull requests
- [Scripts and orchestrators](https://sakuga-software.github.io/boo/automation/): `--json` and
  `--watch --events`
- [Merge policy](https://sakuga-software.github.io/boo/merge-policy/)
- [The list](https://sakuga-software.github.io/boo/the-list/): what a row shows, the stacks
- [Reviewers and checks](https://sakuga-software.github.io/boo/reviewers/)
- [Quotas and retries](https://sakuga-software.github.io/boo/quotas/)
- [Settings](https://sakuga-software.github.io/boo/settings/)
- [Keys and mouse](https://sakuga-software.github.io/boo/keys/)
- [Contributing](https://sakuga-software.github.io/boo/contributing/)

## Development

The repository is a pnpm workspace: the CLI, which npm publishes, is in `packages/cli`, and the site
is in `packages/site`.

```sh
git clone https://github.com/sakuga-software/boo.git
cd boo
pnpm install            # installs the git hooks, and builds packages/cli/dist/
pnpm check              # lint, format, types, tests, coverage and the package, as CI runs them
pnpm site:dev           # the site, on http://localhost:4321/boo/
```

See [Contributing](https://sakuga-software.github.io/boo/contributing/) for each script, the
release and the demo.

## License

MIT
