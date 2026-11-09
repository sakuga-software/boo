# boo mobile

The phone app of boo. It shows the state of the pull requests that the relay reads. For now it has
the sign-in to the relay, the list of the pull requests, the settings, and the config to build it.

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

| Variable         | What it changes                                                              |
| ---------------- | ---------------------------------------------------------------------------- |
| `BOO_RELAY_URL`  | The relay, for example `http://localhost:4621` for a relay on this computer. |
| `BOO_GITHUB_URL` | The GitHub of the device flow. Only for a local demo against a fake GitHub.  |

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

The EAS project does not exist yet. `app.json` holds a placeholder,
`00000000-0000-0000-0000-000000000000`, in `extra.eas.projectId` and in `updates.url`. An owner of
the `sakuga-software` Expo account does this once:

1. In `packages/mobile`, run `npx eas-cli init`, and pick the `sakuga-software` account. It creates
   the project `boo` and writes its id to `extra.eas.projectId`.
2. Run `npx eas-cli update:configure`. It writes `https://u.expo.dev/<project id>` to `updates.url`.
3. Run `npx eas-cli credentials -p ios` and choose the Apple team that signs `dev.sakuga.boo`.
4. Commit the change of `app.json`.

## Checks

`pnpm lint`, `pnpm format`, `pnpm typecheck` and `pnpm test` at the root of the repository cover this
package. The tests run the sign-in logic (`src/relay/*.test.ts`) in Node, against a fake relay and a
fake GitHub; the screen itself is checked in the simulator.
`pnpm mobile:doctor` runs `expo-doctor`, which checks that the packages fit SDK 57. CI runs all five.
