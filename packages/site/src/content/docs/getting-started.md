---
title: Get started
description: Install boo, check gh, and run it once or as a watch.
---

## Installation

```sh
npm install --global @sakuga-software/boo
```

The package installs the `boo` command. To run the sources of a clone instead:

```sh
git clone https://github.com/sakuga-software/boo.git
cd boo
pnpm install          # the prepare script builds packages/cli/dist/
ln -sf "$PWD/packages/cli/dist/cli.js" ~/.local/bin/boo
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
