import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { useRouter, type Href } from 'expo-router';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { withAbortReason } from '../relay/connection';
import { useRelayContext } from '../relay/relay-context';
import { demoExpoUrl, platformOf, projectIdOf, registerPush, type PushStatus } from './register';
import { pathOf } from './taps';

const extra = Constants.expoConfig?.extra;
const projectId = projectIdOf(extra, Constants.easConfig);
// Only for a local demo against a fake Expo: `BOO_EXPO_PUSH_URL` (app.config.js).
const expoUrl = demoExpoUrl(extra?.expoPushUrl);
const platform = platformOf(Notifications, Platform.OS, expoUrl);
const relayFetch = withAbortReason(fetch);

const PushContext = createContext<PushStatus>({ status: 'idle' });

/**
 * Registers the phone for the push notifications of the relay once the person is signed in (#115), and
 * opens the screen that a tapped notification names, from a cold start too. It needs a `RelayProvider`
 * above it.
 */
export function PushProvider({ children }: { children: ReactNode }) {
  const relay = useRelayContext();
  const router = useRouter();
  const connection = relay.state.status === 'signedIn' ? relay.state.connection : undefined;
  const key = connection ? `${connection.url} ${connection.session}` : '';
  const [attempt, setAttempt] = useState(0);
  const [stored, setStored] = useState<PushStatus & { key: string }>({ status: 'idle', key: '' });
  const status: PushStatus = stored.key === key ? stored : { status: 'idle' };
  const { recheck } = relay;
  // The registration asks for the device token, and the system then tells that token to the listener
  // below: a registration that runs must not start another one.
  const running = useRef(false);

  useEffect(() => {
    // A notification that comes while the app is open shows as a banner too.
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  }, []);

  useEffect(() => {
    if (!connection) return;
    let current = true;
    running.current = true;
    void registerPush(connection, platform, { projectId, fetch: relayFetch }).then((result) => {
      if (!current) return;
      running.current = false;
      setStored({ ...result, key });
      // The relay no longer knows the session: the check of the session signs out.
      if (result.status === 'expired') void recheck(connection);
    });
    return () => {
      current = false;
      running.current = false;
    };
  }, [connection, key, attempt, recheck]);

  // A first try that ended with no token tries again when the app comes back: the prompt of the system
  // also sends the app to the background and back, so a try that runs does not start a second one.
  const retry = status.status === 'denied' || status.status === 'unavailable' || status.status === 'failed';
  useEffect(() => {
    // Expo can rotate the token: the relay gets the new one.
    const tokens = Notifications.addPushTokenListener(({ data }) => {
      if (!running.current && platform.isNew(data)) setAttempt((count) => count + 1);
    });
    // The person can turn the notifications on in the settings of the system, then come back.
    const foreground = AppState.addEventListener('change', (next) => {
      if (next === 'active' && retry) setAttempt((count) => count + 1);
    });
    return () => {
      tokens.remove();
      foreground.remove();
    };
  }, [retry]);

  // The last tap on a notification, also the one that started the app. The screen opens once the
  // session is read: a signed-out person sees the sign-in first.
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!response || !connection) return;
    const path = pathOf(response.notification.request.content.data);
    Notifications.clearLastNotificationResponse();
    if (path) router.push(path as Href);
  }, [response, connection, router]);

  return <PushContext.Provider value={status}>{children}</PushContext.Provider>;
}

/** Where this phone stands with the push notifications. */
export const usePushStatus = () => useContext(PushContext);
