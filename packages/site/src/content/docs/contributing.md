---
title: Contributing
description: Work on boo. The workspace, the checks, the release and the demo.
---

The repository is a pnpm workspace. The CLI, which npm publishes, is in `packages/cli`, and this
site is in `packages/site`. The scripts of the root run in the CLI package, except the lint and the
format, which read the whole repository, and the `site:` scripts.

```sh
pnpm dev -- --dry-run   # run the sources with tsx
pnpm test               # the tests, with the dashboard rendered by ink-testing-library
pnpm test:coverage      # the tests, and the coverage that CI asks for
pnpm typecheck          # the sources, the tests and the demo
pnpm lint               # oxlint, a warning fails
pnpm format             # oxfmt --check; pnpm format:fix writes the files
pnpm check:pack         # pack the package, install it in an empty folder and run boo
pnpm check              # all of the above, as CI runs them
pnpm site:dev           # the site, on http://localhost:4321/boo/
pnpm site:build         # build the site in packages/site/dist, as CI does
```

`pnpm install` installs two git hooks (husky). `pre-commit` checks the format and the lint of the
staged files. `pre-push` runs the typecheck and the tests. CI is the gate: `--no-verify` skips a
hook, not CI. CI also runs the tests on Node 22, the oldest version that `engines` accepts, and
checks that the title of a pull request follows the convention of the commits.

## Site

The site uses [Astro Starlight](https://starlight.astro.build/). Each page is a Markdown file in
`packages/site/src/content/docs`, and `astro.config.mjs` gives the sidebar. A push to `main` that
changes the site deploys it on GitHub Pages (`.github/workflows/site.yml`). The README keeps only the
pitch, the installation and the usage: the reference is here.

## Release

A GitHub release publishes the package on npm (`.github/workflows/publish.yml`):

1. In a pull request, change `version` in `packages/cli/package.json`
   (`npm version minor --no-git-tag-version` in that folder), then merge it.
2. Optional: run the workflow by hand on `main` (Actions → Publish → Run workflow). It does all the
   checks and shows what npm would publish, with no publish.
3. Create a release on `main` with the tag `v` + that version, for example `v1.2.0`.

The workflow refuses a tag that does not match the version, and a version that is already on npm.
A first job runs the checks and packs the tarball, with no right to publish. A second job publishes
that tarball with npm trusted publishing: npm trusts the OIDC token of the workflow, so the
repository keeps no npm token, and the package gets a signed provenance. The second job installs
nothing, so no script of a dependency runs next to that token. The package gets the `README.md` and
the `LICENSE` of the root: its `prepack` script copies them.

## Demo

The GIF uses the real interface and the real decision logic with a fake GitHub
(`packages/cli/demo/demo.tsx`). The fake GitHub plays a timeline: a CodeRabbit review in progress, a bot that
shows its progress, a Copilot quota refusal, a CodeRabbit quota that comes back and a retry, a
merged pull request, a new pull request, then the reviews. At the end, it unfolds the first pull
request with `e`, selects another one and unfolds it with `→`, shows the list of the review bots with `b`,
opens the CodeRabbit menu with `r`, and posts
`@coderabbitai approve` with `a`, then `Enter`. Then it goes back to the first pull request, which a
fake local session works on, opens the commands for the agent with `a`, and sends `fix` with `f`,
then `Enter`. To see it live, run `pnpm demo`. To record the GIF again (requires vhs, ttyd and ffmpeg):

```sh
packages/cli/demo/record.sh
```
