# boo-relay

The relay receives the webhooks of a GitHub App and sends them to the `boo` watches as a stream of
server-sent events. With the relay, a watch reads a pull request again only when GitHub says that it
changed, so the polling stops to use the rate limit of your `gh` token.

Each event names what changed (`owner/repo`, the pull request number or the head commit, the event
type) and carries in `data` the fields of the webhook that the watch needs to update its row with no
read of GitHub: the state, head and requested reviewers of a pull request, the author, state and text
of a review or a comment, the state and conclusion of a check, a status or a workflow run. The values
are the ones of the webhook. The access filter below decides who gets these fields.

## What it does

| Route                | Who calls it | What it does                                                                                                        |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `GET /`              | `boo`        | Gives the client id of the App and its install URL.                                                                 |
| `POST /webhooks`     | GitHub       | Checks the signature, keeps the fields that the watch needs, and sends them to the streams.                         |
| `POST /sessions`     | `boo`        | Takes the user token of the App from the device flow, checks that it belongs to the App, and gives a session token. |
| `DELETE /sessions`   | `boo`        | Deletes the session.                                                                                                |
| `GET /installations` | `boo`        | The installations of the App that the user can read.                                                                |
| `GET /events`        | `boo`        | The stream of the changes in the repositories that the user can read through the App.                               |
| `GET /state`         | `boo`, app   | The reports of the user, with the keys of `boo --json`, plus `cursor` and `at`.                                     |
| `GET /state/events`  | `boo`, app   | The stream of the changes of these reports, in the vocabulary of `boo --watch --events`, `id` = the cursor.         |
| `GET /settings`      | `boo`, app   | The watch config of the user: `{ "org", "settings" }`. With no config, the defaults.                                |
| `PUT /settings`      | `boo`, app   | Replaces the watch config of the user (the last write wins), and reads its list of pull requests again.             |
| `GET /healthz`       | the host     | `{ "ok": true, "streams": <count> }`.                                                                               |

A stream gets a change only for a repository that its user can read through the installations of the
App. The relay reads that list with the token of the user, keeps it for 30 minutes, and reads it again
at once after an `installation`, `installation_repositories`, `member`, `membership`, `organization` or
`repository` webhook. During that new read, and if GitHub fails to give the list for an hour, the stream gets no change:
a repository that left an installation must not send one more. The safety poll of the watch covers
that time, and the stream sends `event: reset` when the access is valid again, so the watch reads
all. A resume with `Last-Event-ID` while the access is not valid gets a reset too. One relay can serve several people and several organizations.

## The state of the pull requests

With the key of the App (`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`), the relay keeps the last state of
each pull request that a user follows, so that several clients (several `boo` on several machines, the
mobile app) do not each read GitHub. Without the key, the relay only relays the webhooks, and
`/settings` answers 503.

- **What a user follows.** `PUT /settings` takes the settings file of `boo` (`authors`, `repos`,
  `mergePolicy`, `customBots`, `drafts`…) with `org` beside it: the login of an organization or an
  account, or `""` for every account where the App is installed. A repository named without its owner
  takes `org`. `@me` is the user of the session. The settings belong to the GitHub login, not to the
  session: every client of the user sees the last write.
- **The list.** The relay searches the open pull requests of each author, in each installation of the
  App that the config names. It reads the lists again every 10 minutes, after `PUT /settings`, and
  after a `pull_request` webhook that can add one (opened, reopened, ready for review…).
- **The reads.** A pull request gets a first GraphQL read when a user starts to follow it, then one
  read 2 seconds after each burst of webhooks that name it, or its head commit. A pull request is read
  once for all the users that follow it. The reads use the installation tokens of the App: they count
  on the limit of the installation, not of a user, and they work when no user is signed in.
- **The storage.** `state.db` in `RELAY_DATA_DIR`, a SQLite database (`node:sqlite`). It holds the watch
  config of each user and the last read of each pull request, with the text of its description, its
  reviews and its comments. A read for a user gives only the repositories that the user reads through
  the App.
- **The reports.** `GET /state` gives `{ "cursor", "at", "reports" }`. `reports` is the output of
  `boo --json` (see the automation docs) for the pull requests that the user follows, computed on the
  relay by `buildReport` of core, in the repositories that the user reads through the App now. The
  relay knows no local Claude Code session, so `agent.session` is null. A pull request whose read
  failed keeps its last read that worked; with none, it is in the `error` state. `cursor` changes each
  time a report changes (not when only `idleMinutes` grows), and after a restart of the relay. The
  reports are computed again after each read, after each change of the list or the settings, and every
  minute, for the states that depend on time: a CodeRabbit wait that ends, a pull request that stalls.
- **The stream of the reports.** `GET /state/events` sends each change of the reports as a server-sent
  event, with the vocabulary of `boo --watch --events` (`state`, `head`, `review`, `check`, `findings`,
  `policy`, `left`, `comment`, `review-request`…) as the event name, the JSON line of the watch as
  `data`, and the cursor of `GET /state` as `id`. A report that changed with no event of its own (it
  stalls, its CodeRabbit note changes) gives a `snapshot` event with the whole report. The stream
  starts with `event: ready` and the current cursor. A client reads `GET /state`, then opens the stream
  with its cursor in `Last-Event-ID`: it gets the changes after that cursor. If the relay cannot give
  them all (another boot of the relay, or a cursor older than the last 200 changes), it sends
  `event: reset` with the current cursor, and the client reads `GET /state` again. As on `/events`, the
  stream gets only the repositories that the user reads, and a reset after a time with no valid access.
- **The retention.** The relay deletes a pull request, with its text, 7 days after it is merged or
  closed, or 7 days after nobody follows it any more. The check runs at start and every hour.

## Limits

- The relay keeps the last 10 000 events in memory, and at most 64 MB of them: an event carries the
  text of a review or a comment. A watch that reconnects sends `Last-Event-ID` and
  gets the events that it missed. After a restart of the relay, or after a long cut, the watch gets
  `event: reset` and must read all its pull requests again.
- GitHub can deliver a webhook late or not at all. The watch must keep a slow poll as a safety net.
- A `status`, and a check of a pull request from a fork, give only the head commit: the watch finds
  the pull request from the commit.
- Some facts are in no webhook, so the watch must still read them from GitHub: the mergeable state
  (GitHub computes it after the delivery and often leaves it out), the list of changed files, the
  time of the head commit, and the checks of the base branch.

## Create the GitHub App

In the settings of your organization (or of your account): **Developer settings → GitHub Apps → New
GitHub App**.

- **Homepage URL**: the URL of your relay.
- **Callback URL**: leave empty. `boo setup-webhooks` uses the device flow.
- **Enable Device Flow**: on.
- **Expire user authorization tokens**: on is supported. The relay keeps the refresh token, encrypted.
- **Webhook URL**: `https://<your relay>/webhooks`. **Webhook secret**: a long random value.
- **Repository permissions**, all **read-only**: Pull requests, Issues, Checks, Commit statuses,
  Actions, Metadata. GitHub refuses the `issue_comment` event without Issues: the comments of a pull
  request come through it. No Contents, and no write: `boo` still posts with your `gh` token.
- **Organization permissions**: Members, read-only, to get the `membership` and `organization`
  events.
- **Subscribe to events**: Pull request, Pull request review, Pull request review comment, Pull
  request review thread, Issue comment, Check run, Check suite, Status, Workflow run, Member,
  Membership, Organization, Repository.
- **Where can this GitHub App be installed?**: any account, if other people use your relay.

Then note the **Client ID** and the **App ID**, generate a **client secret** and a **private key**,
and note the **slug** of the App (the end of `github.com/apps/<slug>`). The private key lets the relay
read the pull requests with the tokens of the installations; without it, the relay only relays the
webhooks.

To install the App on an organization, you must be an owner of the organization. A member can only
request the installation, and an owner approves it.

## Run the relay

| Variable                   | Value                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_APP_CLIENT_ID`     | The Client ID of the App.                                                                                                                  |
| `GITHUB_APP_CLIENT_SECRET` | A client secret of the App. The relay checks the tokens and refreshes them with it.                                                        |
| `GITHUB_APP_SLUG`          | The slug of the App.                                                                                                                       |
| `GITHUB_WEBHOOK_SECRET`    | The webhook secret of the App.                                                                                                             |
| `RELAY_ENCRYPTION_KEY`     | A long random value. It encrypts the GitHub tokens in the sessions file. If you change it, every user must run `boo setup-webhooks` again. |
| `GITHUB_APP_ID`            | The App ID. With `GITHUB_APP_PRIVATE_KEY`, the relay keeps the state of the pull requests.                                                 |
| `GITHUB_APP_PRIVATE_KEY`   | The private key of the App, in PEM. In one line, write `\n` for each line break.                                                           |
| `GITHUB_API_URL`           | `https://api.github.com` by default.                                                                                                       |
| `RELAY_DATA_DIR`           | The folder of `sessions.json` and `state.db`. `/data` in the image. Keep it on a volume.                                                   |
| `PORT`                     | `3000` by default.                                                                                                                         |

With Docker, from the root of the repository:

```sh
docker build -f packages/relay/Dockerfile -t boo-relay .
docker run -d --name boo-relay -p 3000:3000 -v boo-relay-data:/data \
  -e GITHUB_APP_CLIENT_ID=... -e GITHUB_APP_CLIENT_SECRET=... -e GITHUB_APP_SLUG=... \
  -e GITHUB_WEBHOOK_SECRET=... -e RELAY_ENCRYPTION_KEY=... \
  boo-relay
```

On Dokploy: an application from this repository, build type Dockerfile, Dockerfile path
`packages/relay/Dockerfile`, build context `.`, the variables above, a volume mounted on `/data`, and a
domain with HTTPS on port 3000.

Put the relay behind HTTPS: GitHub sends the webhooks there, and `boo` sends the session token in each
request. A proxy in front of the relay must not hold the event stream in a buffer and must not cut a
connection that stays open for hours.

## Develop

```sh
pnpm --filter @sakuga-software/boo-relay test
pnpm --filter @sakuga-software/boo-relay dev   # with the variables above
```
