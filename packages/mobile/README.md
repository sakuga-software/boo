# boo mobile

The phone app of boo. It shows the state of the pull requests that the relay reads. For now it is a
scaffold: one home screen, and the config to build it.

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

`pnpm lint`, `pnpm format` and `pnpm typecheck` at the root of the repository cover this package.
`pnpm mobile:doctor` runs `expo-doctor`, which checks that the packages fit SDK 57. CI runs all four.
