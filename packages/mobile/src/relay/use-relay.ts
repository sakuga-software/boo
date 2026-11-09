import { closeRelaySession, type RelayConnection } from '@sakuga-software/boo-core/relay';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseStoredRelay, probeRelay, RELAY_URL_KEY } from '../settings/relay-url';
import { relayConfig } from './config';
import { checkSession, CONNECTION_KEY, parseConnection, withAbortReason } from './connection';
import { startSignIn, type SignIn } from './sign-in';
import { signOutOnce } from './sign-out';
import { afterCheck, afterSignOut, markSigningOut, type RelayState } from './state';

export type { RelayState } from './state';

// Only this phone reads the session token, and only after its first unlock: no backup and no other
// device gets it. The first unlock, not each one, so that a later refresh in the background can read it.
const STORE: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const config = relayConfig(Constants.expoConfig?.extra);
const relayFetch = withAbortReason(fetch);

// One sign-out at a time for a session, whatever the count of taps (#55f5ef).
const endSession = signOutOnce({
  fetch: relayFetch,
  forget: () => SecureStore.deleteItemAsync(CONNECTION_KEY, STORE),
});

const openBrowser = (url: string) => {
  // The promise ends when the person closes the browser. The sign-in does not wait for it.
  WebBrowser.openBrowserAsync(url).catch(() => {});
};

/** The connection to the relay: the stored session, the sign-in with the device flow, and the sign-out. */
export function useRelay() {
  const [state, setState] = useState<RelayState>({ status: 'loading' });
  // The relay that the person chose in the settings, or the one of `app.json`.
  const [relayUrl, setRelayUrl] = useState(config.relayUrl);
  const signIn = useRef<SignIn | undefined>(undefined);
  const changing = useRef(false);

  const checkInstallations = useCallback(async (connection: RelayConnection, asked = false) => {
    const check = await checkSession(connection, relayFetch);
    // The relay no longer knows the session: the phone forgets it too.
    if (check.status === 'expired') await SecureStore.deleteItemAsync(CONNECTION_KEY, STORE).catch(() => {});
    setState((current) => afterCheck(current, connection, check, asked));
  }, []);

  useEffect(() => {
    void (async () => {
      if (!(await SecureStore.isAvailableAsync())) {
        setState({ status: 'signedOut', notice: 'The sign-in needs the iOS or Android app.' });
        return;
      }
      const chosen = parseStoredRelay(await SecureStore.getItemAsync(RELAY_URL_KEY, STORE).catch(() => null));
      if (chosen) setRelayUrl(chosen);
      const connection = parseConnection(await SecureStore.getItemAsync(CONNECTION_KEY, STORE).catch(() => null));
      if (!connection) return setState({ status: 'signedOut' });
      setState({ status: 'signedIn', connection });
      await checkInstallations(connection);
    })();
  }, [checkInstallations]);

  const start = useCallback(() => {
    const run = startSignIn({
      ...config,
      relayUrl,
      fetch: relayFetch,
      openBrowser,
      copy: async (text) => void (await Clipboard.setStringAsync(text)),
      onStep: (step) => setState({ status: 'signingIn', step }),
    });
    signIn.current = run;
    run.done
      .then(async (connection) => {
        if (signIn.current !== run) return;
        signIn.current = undefined;
        if (!connection) return setState({ status: 'signedOut' });
        try {
          await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection), STORE);
        } catch {
          // A session that the phone cannot keep must not stay on the relay.
          await closeRelaySession(connection, { fetch: relayFetch, log: () => {} });
          return setState({ status: 'signedOut', notice: 'The phone could not keep the session. Sign in again.' });
        }
        setState({ status: 'signedIn', connection });
        await checkInstallations(connection);
      })
      .catch(() => {
        // The step `failed` shows the error.
        if (signIn.current === run) signIn.current = undefined;
      });
  }, [checkInstallations, relayUrl]);

  const signOut = useCallback(async () => {
    if (state.status !== 'signedIn' || state.signingOut) return;
    const { connection } = state;
    setState(markSigningOut);
    await endSession(connection);
    setState((current) => afterSignOut(current, connection));
  }, [state]);

  /**
   * Moves the app to another relay, or back to the one of `app.json` with `undefined`. The new relay must
   * answer as a boo relay first. Then the app signs out of the current relay: its session belongs to that
   * relay only. The person signs in again on the new one. Returns the problem, or `undefined`.
   */
  const changeRelay = useCallback(
    async (url: string | undefined): Promise<string | undefined> => {
      if (state.status !== 'signedIn' && state.status !== 'signedOut') return 'Wait for the sign-in to end.';
      if (state.status === 'signedIn' && state.signingOut) return 'Wait for the sign-out to end.';
      // As for the sign-out: a second tap can come before the render that disables the button.
      if (changing.current) return 'The relay is already changing.';
      changing.current = true;
      try {
        const next = url ?? config.relayUrl;
        const problem = await probeRelay(next, relayFetch);
        if (problem) return problem;
        if (state.status === 'signedIn') {
          setState(markSigningOut);
          await endSession(state.connection);
        }
        try {
          if (url === undefined) await SecureStore.deleteItemAsync(RELAY_URL_KEY, STORE);
          else await SecureStore.setItemAsync(RELAY_URL_KEY, url, STORE);
        } catch {
          // The app uses the relay until it restarts.
        }
        setRelayUrl(next);
        setState({ status: 'signedOut', notice: `The relay is now ${next}. Sign in again.` });
        return undefined;
      } finally {
        changing.current = false;
      }
    },
    [state],
  );

  return {
    state,
    relayUrl,
    defaultRelayUrl: config.relayUrl,
    start,
    signOut,
    changeRelay,
    openGitHub: () => signIn.current?.openGitHub(),
    openInstall: () => signIn.current?.openInstall(),
    later: () => signIn.current?.later(),
    cancel: () => {
      signIn.current?.cancel();
    },
    retry: () => setState({ status: 'signedOut' }),
    install: (url: string) => openBrowser(url),
    checkAgain: (connection: RelayConnection) => checkInstallations(connection, true),
    /** The same check with no notice, for a screen that got a 401 from the relay. Its identity stays across renders. */
    recheck: checkInstallations,
  };
}
