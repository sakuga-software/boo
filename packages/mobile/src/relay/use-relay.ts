import {
  closeRelaySession,
  readInstallations,
  SetupError,
  type RelayConnection,
} from '@sakuga-software/boo-core/relay';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { relayConfig } from './config';
import { CONNECTION_KEY, parseConnection, withAbortReason } from './connection';
import { startSignIn, type SignIn, type SignInStep } from './sign-in';

export type RelayState =
  | { status: 'loading' }
  | { status: 'signedOut'; notice?: string }
  | { status: 'signingIn'; step: SignInStep }
  | {
      status: 'signedIn';
      connection: RelayConnection;
      /** Set when the user reads no installation of the App: the page that installs it. */
      installUrl?: string;
      signingOut?: boolean;
    };

// Only this phone reads the session token, and only after its first unlock: no backup and no other
// device gets it. The first unlock, not each one, so that a later refresh in the background can read it.
const STORE: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const config = relayConfig(Constants.expoConfig?.extra);
const relayFetch = withAbortReason(fetch);

const openBrowser = (url: string) => {
  // The promise ends when the person closes the browser. The sign-in does not wait for it.
  WebBrowser.openBrowserAsync(url).catch(() => {});
};

/** The connection to the relay: the stored session, the sign-in with the device flow, and the sign-out. */
export function useRelay() {
  const [state, setState] = useState<RelayState>({ status: 'loading' });
  const signIn = useRef<SignIn | undefined>(undefined);

  const checkInstallations = useCallback(async (connection: RelayConnection) => {
    try {
      const { installations, installUrl } = await readInstallations(connection, { fetch: relayFetch });
      setState((current) =>
        current.status === 'signedIn' && current.connection.session === connection.session
          ? { status: 'signedIn', connection, ...(installations.length === 0 && { installUrl }) }
          : current,
      );
    } catch (error) {
      // 401: the relay no longer knows the session. Another error (no network) keeps the session.
      if (error instanceof SetupError && /: 401\b/.test(error.message)) {
        await SecureStore.deleteItemAsync(CONNECTION_KEY, STORE).catch(() => {});
        setState({ status: 'signedOut', notice: 'The relay ended the session. Sign in again.' });
      }
    }
  }, []);

  useEffect(() => {
    void (async () => {
      if (!(await SecureStore.isAvailableAsync())) {
        setState({ status: 'signedOut', notice: 'The sign-in needs the iOS or Android app.' });
        return;
      }
      const connection = parseConnection(await SecureStore.getItemAsync(CONNECTION_KEY, STORE).catch(() => null));
      if (!connection) return setState({ status: 'signedOut' });
      setState({ status: 'signedIn', connection });
      await checkInstallations(connection);
    })();
  }, [checkInstallations]);

  const start = useCallback(() => {
    const run = startSignIn({
      ...config,
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
  }, [checkInstallations]);

  const signOut = useCallback(async () => {
    if (state.status !== 'signedIn') return;
    const { connection } = state;
    setState({ ...state, signingOut: true });
    // A relay that does not answer keeps the session until it expires; the phone forgets it anyway.
    await closeRelaySession(connection, { fetch: relayFetch, log: () => {} });
    await SecureStore.deleteItemAsync(CONNECTION_KEY, STORE).catch(() => {});
    setState({ status: 'signedOut' });
  }, [state]);

  return {
    state,
    relayUrl: config.relayUrl,
    start,
    signOut,
    openGitHub: () => signIn.current?.openGitHub(),
    openInstall: () => signIn.current?.openInstall(),
    later: () => signIn.current?.later(),
    cancel: () => {
      signIn.current?.cancel();
    },
    retry: () => setState({ status: 'signedOut' }),
    install: (url: string) => openBrowser(url),
    checkInstallations,
  };
}
