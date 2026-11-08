---
title: Webhooks
description: Connect boo to a webhook relay, so that a watch reads GitHub only when a pull request changes.
---

A watch polls GitHub: it searches the list each minute and reads each pull request again every few
minutes, with the rate limit of your `gh` token. A webhook relay receives the webhooks of a GitHub
App and streams each change to the watches, so a watch reads GitHub much less.

## Set up

```sh
boo setup-webhooks                        # the relay that Sakuga hosts: https://boo-relay.sakuga.dev
boo setup-webhooks relay.example.com      # a relay of your own
```

1. boo shows a code: open `https://github.com/login/device`, type the code, and authorize the App
   of the relay. boo opens the page for you.
2. If you read no installation of the App, boo opens its install page and waits for an installation.
   An owner of an organization installs it; a member can only request it.
3. boo saves the relay URL and its session in `~/.config/boo/relay.json` (or under
   `$XDG_CONFIG_HOME`), readable only by you. Your GitHub token stays on the relay, encrypted: the
   file holds only a session token of the relay.

```sh
boo setup-webhooks --remove   # delete the session on the relay, then the file
```

## What the relay sends

Each event names the repository and the pull request (or its head commit), with the fields of the
webhook that the watch needs: the state and head of a pull request, the author, state and text of a
review or a comment, the state of a check, a status or a workflow run. A session gets the events of
the repositories that its user can read through the installations of the App, and nothing else.

To run your own relay, see the
[README of the relay](https://github.com/sakuga-software/boo/tree/main/packages/relay).

## In the watch

With a relay, `boo --watch` reads the stream of the relay:

- A change reads only its pull request again, a few seconds after the last change of a burst: a push
  gives about twenty check events. A read by another run of boo on this machine after the change
  answers with no query.
- A pull request that opens, closes or leaves draft reads the list again.
- The list and every pull request get a safety read every 10 minutes, for a webhook that GitHub
  delivers late or not at all.
- The header shows the state of the stream: `live · safety check in 9:58`, or `poll · next check in
  0:28` while the stream is down and the watch polls as without a relay. `relay session ended: run
  boo setup-webhooks` means that the relay no longer knows the session.

Without `~/.config/boo/relay.json`, the watch polls GitHub as before. `--json` and `--watch --events`
poll in both cases.
