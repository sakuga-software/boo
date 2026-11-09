# boo mobile

The phone app of boo. It shows the state of the pull requests that the relay reads: the sign-in to
the relay, the list of the pull requests, the details of each one, and the settings.

- Expo SDK 57, [expo-router](https://docs.expo.dev/router/introduction/) with typed routes, and the
  React Compiler (`experiments` in `app.json`).
- Bundle id and Android package: `dev.sakuga.boo`.
- EAS project under the `sakuga-software` account. Updates use the fingerprint runtime policy.

## Run it on a computer

From the root of the repository:

```sh
pnpm install
cd packages/mobile
pnpm web     # in a browser, no native build
pnpm ios     # builds the dev client locally and opens it in the iOS simulator (needs Xcode)
```

`expo start` writes the types of the routes to `.expo/types/router.d.ts`. `pnpm typecheck` reads
them when they are there. Without them, `Href` accepts any string, so CI still checks the rest of the
types.

Core is TypeScript with ES module imports (`./bots.js` for `bots.ts`). `metro.config.js` drops the `.js`
of a relative import inside `packages/core/src`, so Metro finds the `.ts` file.

## Sign in to the relay

The home screen signs in with the device flow of GitHub, on the relay of the settings. The code is the one of the CLI
(`connectRelay` and `closeRelaySession` in `packages/core/src/relay.ts`):

1. The screen shows a code. **Copy the code and open GitHub** copies it to the clipboard and opens
   `github.com/login/device` in the in-app browser (expo-web-browser). The person pastes the code
   there. The app polls GitHub through core meanwhile.
2. The app sends the GitHub token to the relay (`POST /sessions`) and keeps only the session token
   that the relay gives back. It goes to `expo-secure-store` (the iOS keychain, Android Keystore),
   readable on this phone only, after its first unlock.
3. If the user reads no installation of the App, the screen gives a link to install it, and waits
   for one. **Later** keeps the session without an installation; the account screen then shows the
   link again.
4. **Sign out** deletes the session on the relay (`DELETE /sessions`), then on the phone. A relay
   that does not answer keeps the session until it expires; the phone forgets it anyway.

### Which relay

`expo.extra.relayUrl` in `app.json` gives the relay. The default is the relay that Sakuga hosts,
`https://boo-relay.sakuga.dev` (`DEFAULT_RELAY` of core, also used when the key is missing). Two
variables of the environment change it when Metro starts, through `app.config.js`:

| Variable            | What it changes                                                                        |
| ------------------- | -------------------------------------------------------------------------------------- |
| `BOO_RELAY_URL`     | The relay, for example `http://localhost:4621` for a relay on this computer.           |
| `BOO_GITHUB_URL`    | The GitHub of the device flow. Only for a local demo against a fake GitHub.            |
| `BOO_EXPO_PUSH_URL` | The Expo service that gives the push token. Only for a local demo against a fake Expo. |

`http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`: core refuses it elsewhere.

```sh
BOO_RELAY_URL=http://localhost:4621 pnpm ios
```

## Settings

**Settings**, on the home screen when signed out and on the account screen when signed in, edits two things.

- **The relay of this phone.** The field takes a URL, as `boo setup-webhooks` does: `https://` when the
  scheme is missing, no trailing slash, `http://` only on this machine. **Use this relay** first asks the
  new URL if it is a boo relay (`GET /`, with no token). Then the app signs out of the current relay
  (`DELETE /sessions`): a session belongs to one relay only. The person signs in again on the new one.
  The phone keeps the choice in `expo-secure-store` (`boo.relay.url`). **Use the default relay** goes back
  to the relay of `app.json`, and forgets the choice.
- **What the relay follows** (signed in only): the organization, the authors and the repositories. The
  screen reads `GET /settings` and saves with `PUT /settings`. The settings live on the relay, and the
  last write wins (D6): the CLI and the other phones of the user read the same ones. The relay takes the
  whole settings file, so the settings that this screen does not edit (the bots, the merge policy, the
  switches) go back as the relay gave them. After a save, the relay reads the list of pull requests
  again. No repository means every repository of the organization; a repository named with no owner
  takes the organization.

A tap on **Sign out** or on **Use this relay** that comes before the screen renders the first one sends
nothing more (`signOutOnce` in `src/relay/sign-out.ts`, `relayChanger` in `src/relay/change-relay.ts`).
The change of relay signs out of the session of the state after the check of the new relay, not before
it: the session can end during that check.

## Put the dev client on a phone

A development build is the app with `expo-dev-client` in it. It loads the JavaScript from the Metro
server of your computer, so a change shows on the phone at once. Build it once per phone, and again
when a native package changes (the fingerprint changes).

You need an Expo account that is a member of `sakuga-software`, and for iOS an Apple Developer team.

1. Log in: `npx eas-cli login`.
2. **iOS only:** register the phone in the Apple team. Run `npx eas-cli device:create`, choose the
   website option, and open the link on the phone. The phone installs a profile, then shows in
   `npx eas-cli device:list`.
3. Build the dev client for a phone:

   ```sh
   npx eas-cli build -p ios --profile development-device
   npx eas-cli build -p android --profile development-device
   ```

   For the iOS simulator, use the `development` profile.

4. Install it: open the link or scan the QR code that EAS prints at the end of the build, on the
   phone. On iOS 16 or later, turn on **Settings → Privacy & Security → Developer Mode** the first
   time.
5. Start Metro on the computer, on the same network as the phone:

   ```sh
   pnpm start   # expo start --dev-client
   ```

   Open the boo app on the phone. It finds the server, or scan the QR code that Metro prints.

## Build profiles

| Profile              | What it gives                                                        |
| -------------------- | -------------------------------------------------------------------- |
| `development`        | Dev client for the iOS simulator and Android, internal distribution. |
| `development-device` | Dev client for a registered phone, internal distribution.            |
| `preview`            | The app without the dev client, internal distribution.               |
| `production`         | The build for the stores. EAS increments the build number.           |

`cli.appVersionSource` is `remote`: EAS keeps the build numbers, not `app.json`.

## Before the first build

The EAS project is `boo` under the `sakuga-software` account
(<https://expo.dev/accounts/sakuga-software/projects/boo>). `app.json` holds its id in
`extra.eas.projectId` and in `updates.url`, and the Apple team `669547726G` in `ios.appleTeamId`. An owner
of the Apple team and of the Firebase project does this once:

1. Run `npx eas-cli credentials -p ios` and choose the Apple team that signs `dev.sakuga.boo`.
   Under **Push Notifications**, let EAS make an APNs key (or upload one): the push notifications
   need it.
2. **Android:** in a Firebase project, add an Android app `dev.sakuga.boo`.
   - Upload the FCM V1 service account key of the project to EAS (`npx eas-cli credentials -p android`
     → **Google Service Account** → **Push Notifications**): Expo sends with it.
   - Download its `google-services.json`, and add it to EAS as an environment variable of type
     **file**, named `GOOGLE_SERVICES_JSON`, for each environment (`npx eas-cli env:create`).
     `app.config.js` gives it to `android.googleServicesFile`: the phone needs it to get a push token.
     The file stays out of the repository.

## The pull requests

Once signed in, the home screen lists the reports of `GET /state`, with the session token. A row
says what a row of `boo` says in the terminal: the state, `repo#n`, the title, the place in the
stack, the agent, `zZ stalled`, the checks and the mark of each reviewer. The words come from the
report, and the marks and their tones from `packages/core/src/theme.ts`, which the CLI reads too.

- The app reads the list when the session starts, and when you pull the list down. A read that
  fails keeps the older list, and a banner gives the error and the time of that list.
- In the foreground, the list stays live: the app opens `GET /state/events` from the cursor of its
  last read, with the reader of core (`relayStream`, over `expo/fetch`). Each burst of events reads
  `GET /state` again; `event: reset` reads it at once. The stream closes in the background, and opens
  again in the foreground with `Last-Event-ID`: the relay sends the changes since, or a reset. The
  header says `live` while the stream is open, and `poll` while it is down: the list is then read
  every minute, as the stream tries again.
- A tap on a row opens its details: the size of the change, the agent, the reviewers with their
  scores and times, the checks with the names of the ones that fail, and the notes (merge policy,
  stall, stack, merge state, retries, CodeRabbit quota, stale read). **Open on GitHub** opens the
  pull request.
- A 401 on `/state` checks the session again (`GET /installations`): a session that the relay no
  longer knows signs out.
- The login in the header opens the account: the relay, the install link of the App, and the
  sign-out.

## Push notifications

Once signed in, the app registers the phone for the push notifications of the relay
(`src/push/register.ts`, mounted by `PushProvider` in `_layout.tsx`):

1. The permission of the system. iOS shows its prompt once; after a refusal, the settings screen
   says to turn the notifications on in the iOS settings, and the app tries again each time it comes
   back to the foreground.
2. The Expo push token, for the EAS project of `extra.eas.projectId`. With the placeholder id of
   `app.json`, the app gets no token, and the settings screen says so (see **Before the first build**).
3. `POST /devices` on the relay, with the session token. The relay keeps one token for each session, and
   **Sign out** (`DELETE /sessions`) deletes it. A new token from Expo is sent again.

The relay sends a notification when a pull request changes to ready to merge, changes requested,
checks failing, conflicts, merged, or starts to stall. **Settings → Push notifications** has one switch
for each: they are the `push` key of the settings on the relay, saved with the other settings (D6).

A tap on a notification opens its pull request (`boo://pull/<owner>/<repo>/<number>`), also when it
starts the app; the app opens the screen once the session is read. A notification that comes while the
app is open shows as a banner too.

The iOS simulator gets no real push from APNs. For a local demo, `BOO_EXPO_PUSH_URL` (only
`http://localhost` or `127.0.0.1`) points the token request to a fake Expo service, and
`xcrun simctl push` hands a notification to the simulator.

## Checks

`pnpm lint`, `pnpm format`, `pnpm typecheck` and `pnpm test` at the root of the repository cover this
package. The tests run the sign-in logic (`src/relay/*.test.ts`) and the logic of the list and of the details
(`src/pulls/*.test.ts`) in Node, against a fake relay and a fake GitHub; the screens themselves are
checked in the simulator.
`pnpm mobile:doctor` runs `expo-doctor`, which checks that the packages fit SDK 57. CI runs all five.
