---
title: Settings
description: The settings panel, the authors, the repositories and the review bots.
---

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

## Review bots

The settings list the review bots of the action bar, with their key, the way the tool asks them, and
their logins.

- `Space` or `Enter` turns a bot on or off. A bot that is off leaves the list of the review bots, and
  CodeRabbit gets no more automatic retries. The tool still shows the bot as a reviewer.
- `a` turns the automatic retry of a bot on or off. It is on for CodeRabbit only. See
  [Retries of the other bots](../quotas/#retries-of-the-other-bots).
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
