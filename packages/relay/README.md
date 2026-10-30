# boo-relay

The relay receives the webhooks of a GitHub App and sends them to the `boo` watches as a stream of
server-sent events. With the relay, a watch reads a pull request again only when GitHub says that it
changed, so the polling stops to use the rate limit of your `gh` token.

The relay sends only the name of what changed: `owner/repo`, the pull request number or the head
commit, and the event type. It never sends a title, a comment or a check name. The watch reads the
pull request again with its own token, so GitHub stays the judge of what each person can read.

## What it does

| Route                | Who calls it | What it does                                                                                                        |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `GET /`              | `boo`        | Gives the client id of the App and its install URL.                                                                 |
| `POST /webhooks`     | GitHub       | Checks the signature, keeps the pull request number or the head commit, and sends it to the streams.                |
| `POST /sessions`     | `boo`        | Takes the user token of the App from the device flow, checks that it belongs to the App, and gives a session token. |
| `DELETE /sessions`   | `boo`        | Deletes the session.                                                                                                |
| `GET /installations` | `boo`        | The installations of the App that the user can read.                                                                |
| `GET /events`        | `boo`        | The stream of the changes in the repositories that the user can read through the App.                               |
| `GET /healthz`       | the host     | `{ "ok": true, "streams": <count> }`.                                                                               |

A stream gets a change only for a repository that its user can read through the installations of the
App. The relay reads that list with the token of the user, keeps it for 30 minutes, and reads it again
at once after an `installation`, `installation_repositories`, `member`, `membership`, `organization` or
`repository` webhook. One relay can serve several people and several organizations.

## Limits

- The relay keeps the last 10 000 events in memory. A watch that reconnects sends `Last-Event-ID` and
  gets the events that it missed. After a restart of the relay, or after a long cut, the watch gets
  `event: reset` and must read all its pull requests again.
- GitHub can deliver a webhook late or not at all. The watch must keep a slow poll as a safety net.
- A `status`, and a check of a pull request from a fork, give only the head commit: the watch finds
  the pull request from the commit.

## Create the GitHub App

In the settings of your organization (or of your account): **Developer settings → GitHub Apps → New
GitHub App**.

- **Homepage URL**: the URL of your relay.
- **Callback URL**: leave empty. `boo setup-webhooks` uses the device flow.
- **Enable Device Flow**: on.
- **Expire user authorization tokens**: on is supported. The relay keeps the refresh token, encrypted.
- **Webhook URL**: `https://<your relay>/webhooks`. **Webhook secret**: a long random value.
- **Repository permissions**, all **read-only**: Pull requests, Checks, Commit statuses, Actions,
  Metadata. No Contents, and no write: `boo` still posts with your `gh` token.
- **Organization permissions**: Members, read-only, to get the `membership` and `organization`
  events.
- **Subscribe to events**: Pull request, Pull request review, Pull request review comment, Pull
  request review thread, Issue comment, Check run, Check suite, Status, Workflow run, Member,
  Membership, Organization, Repository.
- **Where can this GitHub App be installed?**: any account, if other people use your relay.

Then note the **Client ID**, generate a **client secret**, and note the **slug** of the App (the end
of `github.com/apps/<slug>`). The relay needs no private key.

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
| `RELAY_DATA_DIR`           | The folder of `sessions.json`. `/data` in the image. Keep it on a volume.                                                                  |
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
