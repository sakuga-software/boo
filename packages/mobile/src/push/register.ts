import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import type * as Notifications from 'expo-notifications';
import { withAbortReason } from '../relay/connection';

/** What the phone can do for the push notifications. `platformOf` builds it from `expo-notifications`. */
export interface PushPlatform {
  /** True if the person already answered the prompt, or cannot be asked again. */
  permission(): Promise<{ granted: boolean; canAsk: boolean }>;
  /** Shows the prompt of the system. */
  ask(): Promise<boolean>;
  /** The Expo push token of this install, for the EAS project. */
  token(projectId: string): Promise<string>;
  /**
   * True if `deviceToken` (APNs or FCM) is not the one of the last `token`. The system tells each new
   * device token, also the one that `token` itself asks for: only a new one needs a new registration.
   */
  isNew(deviceToken: unknown): boolean;
}

/** Where the phone stands with the push notifications. */
export type PushStatus =
  | { status: 'idle' }
  | { status: 'registered'; token: string }
  /** The person refused the notifications: the iOS or Android settings turn them on again. */
  | { status: 'denied' }
  /** The app cannot get a push token: no EAS project, or a phone with no push service. */
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; message: string }
  /** The relay no longer knows the session (401). */
  | { status: 'expired' };

// `app.json` holds this id until `eas init` writes the id of the EAS project (D8).
const PLACEHOLDER = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id of the EAS project: `extra.eas.projectId` of the config, or `easConfig.projectId` of a build of
 * EAS. The zero id of `app.json` is not a project: it gives `undefined`.
 */
export function projectIdOf(
  extra: Record<string, unknown> | undefined,
  easConfig?: { projectId?: unknown } | null,
): string | undefined {
  const eas = extra?.eas as { projectId?: unknown } | undefined;
  for (const value of [eas?.projectId, easConfig?.projectId])
    if (typeof value === 'string' && UUID.test(value) && !PLACEHOLDER.test(value)) return value;
  return undefined;
}

/**
 * The fake Expo service of a local demo (`BOO_EXPO_PUSH_URL`), only on this machine: the device token of
 * the phone must not go to another host.
 */
export function demoExpoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ? value.replace(/\/+$/, '')
      : undefined;
  } catch {
    return undefined;
  }
}

type NotificationsApi = Pick<
  typeof Notifications,
  | 'getPermissionsAsync'
  | 'requestPermissionsAsync'
  | 'getExpoPushTokenAsync'
  | 'getDevicePushTokenAsync'
  | 'setNotificationChannelAsync'
  | 'AndroidImportance'
>;

/**
 * The push platform of `expo-notifications`. `expoUrl` replaces the Expo service that gives the token,
 * only for a local demo against a fake Expo (`BOO_EXPO_PUSH_URL`).
 */
export function platformOf(notifications: NotificationsApi, os: string, expoUrl?: string): PushPlatform {
  let device: string | undefined;
  return {
    async permission() {
      const { granted, canAskAgain, status } = await notifications.getPermissionsAsync();
      // iOS answers `undetermined` before the first prompt.
      return { granted, canAsk: !granted && canAskAgain && status === 'undetermined' };
    },
    async ask() {
      if (os === 'android')
        // Android 13 shows the prompt only once the app has a channel.
        await notifications.setNotificationChannelAsync('default', {
          name: 'Pull requests',
          importance: notifications.AndroidImportance.HIGH,
        });
      const { granted } = await notifications.requestPermissionsAsync();
      return granted;
    },
    async token(projectId) {
      const devicePushToken = await notifications.getDevicePushTokenAsync();
      device = JSON.stringify(devicePushToken.data);
      const { data } = await notifications.getExpoPushTokenAsync({
        projectId,
        devicePushToken,
        ...(expoUrl && { baseUrl: `${expoUrl}/--/api/v2/` }),
      });
      return data;
    },
    isNew: (deviceToken) => JSON.stringify(deviceToken) !== device,
  };
}

const TIMEOUT_MS = 15_000;

/** Sends the token to `POST /devices` of the relay with the session token. A redirect could send the token elsewhere: refused. */
async function postDevice(
  connection: RelayConnection,
  fetchFn: typeof fetch,
  token: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  let response: Response;
  try {
    response = await withAbortReason(fetchFn)(`${connection.url}/devices`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.session}` },
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      return { ok: false, status: 0, message: `The relay did not answer in ${TIMEOUT_MS / 1000} s.` };
    return { ok: false, status: 0, message: 'The relay did not answer. Try again later.' };
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: true };
  }
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return {
    ok: false,
    status: response.status,
    message: `The relay refused the phone (${response.status})${typeof body?.error === 'string' ? `: ${body.error}` : '.'}`,
  };
}

/**
 * Registers the phone for the push notifications of the relay (#115):
 * 1. the permission of the system, with its prompt the first time;
 * 2. the Expo push token for the EAS project;
 * 3. `POST /devices` on the relay, with the session token. The relay keeps one token for each session.
 *
 * Never throws: a phone with no notification is an ordinary case.
 */
export async function registerPush(
  connection: RelayConnection,
  platform: PushPlatform,
  { projectId, fetch: fetchFn }: { projectId: string | undefined; fetch: typeof fetch },
): Promise<PushStatus> {
  let token: string;
  try {
    const { granted, canAsk } = await platform.permission();
    if (!granted && !(canAsk && (await platform.ask()))) return { status: 'denied' };
    if (!projectId)
      return {
        status: 'unavailable',
        reason: 'This build has no EAS project: the push notifications need extra.eas.projectId in app.json.',
      };
    token = await platform.token(projectId);
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `This phone gives no push token: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = await postDevice(connection, fetchFn, token);
  if (result.ok) return { status: 'registered', token };
  if (result.status === 401) return { status: 'expired' };
  return { status: 'failed', message: result.message };
}
