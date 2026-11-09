import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import { demoExpoUrl, platformOf, projectIdOf, registerPush, type PushPlatform } from './register';

const connection: RelayConnection = { url: 'https://relay.test', session: 'sess', login: 'alice' };
const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const TOKEN = 'ExponentPushToken[abc]';

/** A mock of `expo-notifications`: it records the calls, and answers as a phone would. */
function mockNotifications(
  permission: { status: 'granted' | 'denied' | 'undetermined'; canAskAgain?: boolean },
  answer = permission.status,
) {
  const calls: string[] = [];
  const module = {
    AndroidImportance: { HIGH: 6 },
    getPermissionsAsync: async () => {
      calls.push('getPermissions');
      return {
        status: permission.status,
        granted: permission.status === 'granted',
        canAskAgain: permission.canAskAgain ?? true,
      };
    },
    requestPermissionsAsync: async () => {
      calls.push('requestPermissions');
      return { status: answer, granted: answer === 'granted', canAskAgain: false };
    },
    setNotificationChannelAsync: async (id: string, channel: { importance: number }) => {
      calls.push(`channel ${id} ${channel.importance}`);
      return null;
    },
    getDevicePushTokenAsync: async () => ({ type: 'ios' as const, data: 'apns-1' }),
    getExpoPushTokenAsync: async (options: {
      projectId?: string;
      baseUrl?: string;
      devicePushToken?: { data: string };
    }) => {
      calls.push(`token ${options.projectId}${options.baseUrl ? ` ${options.baseUrl}` : ''}`);
      assert.equal(options.devicePushToken?.data, 'apns-1');
      return { type: 'expo' as const, data: TOKEN };
    },
  };
  return { module: module as unknown as Parameters<typeof platformOf>[0], calls };
}

function fakeRelay(answer: () => Response | Promise<Response> = () => Response.json({ token: TOKEN })) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return answer();
  }) as typeof fetch;
  return { fetchFn, requests };
}

test('the first registration asks the permission, gets the token of the EAS project and sends it to the relay', async () => {
  const { module, calls } = mockNotifications({ status: 'undetermined' }, 'granted');
  const { fetchFn, requests } = fakeRelay();
  const result = await registerPush(connection, platformOf(module, 'ios'), { projectId: PROJECT, fetch: fetchFn });
  assert.deepEqual(result, { status: 'registered', token: TOKEN });
  assert.deepEqual(calls, ['getPermissions', 'requestPermissions', `token ${PROJECT}`]);
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests as [{ url: string; init: RequestInit }];
  assert.equal(url, 'https://relay.test/devices');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(init.headers, { 'content-type': 'application/json', authorization: 'Bearer sess' });
  assert.deepEqual(JSON.parse(String(init.body)), { token: TOKEN });
});

test('a permission already given shows no prompt; Android gets its channel before the prompt', async () => {
  const granted = mockNotifications({ status: 'granted' });
  await registerPush(connection, platformOf(granted.module, 'ios'), { projectId: PROJECT, fetch: fakeRelay().fetchFn });
  assert.deepEqual(granted.calls, ['getPermissions', `token ${PROJECT}`]);
  const android = mockNotifications({ status: 'undetermined' }, 'granted');
  await registerPush(connection, platformOf(android.module, 'android'), {
    projectId: PROJECT,
    fetch: fakeRelay().fetchFn,
  });
  assert.deepEqual(android.calls, ['getPermissions', 'channel default 6', 'requestPermissions', `token ${PROJECT}`]);
});

test('a refused prompt, or a refusal from before, sends nothing to the relay', async () => {
  for (const [permission, answer] of [
    [{ status: 'undetermined' }, 'denied'],
    [{ status: 'denied', canAskAgain: false }, 'denied'],
    [{ status: 'denied', canAskAgain: true }, 'granted'],
  ] as const) {
    const { module, calls } = mockNotifications(permission, answer);
    const { fetchFn, requests } = fakeRelay();
    assert.deepEqual(
      await registerPush(connection, platformOf(module, 'ios'), { projectId: PROJECT, fetch: fetchFn }),
      {
        status: 'denied',
      },
    );
    assert.equal(requests.length, 0);
    // iOS shows its prompt once: a refusal is not asked again by the app.
    assert.equal(calls.includes('requestPermissions'), permission.status === 'undetermined');
  }
});

test('with no EAS project, the phone asks the permission but gets no token', async () => {
  const { module, calls } = mockNotifications({ status: 'undetermined' }, 'granted');
  const { fetchFn, requests } = fakeRelay();
  const result = await registerPush(connection, platformOf(module, 'ios'), { projectId: undefined, fetch: fetchFn });
  assert.equal(result.status, 'unavailable');
  assert.match((result as { reason: string }).reason, /extra\.eas\.projectId/);
  assert.deepEqual(calls, ['getPermissions', 'requestPermissions']);
  assert.equal(requests.length, 0);
});

test('a phone with no push service, or a mock that throws, gives unavailable and no throw', async () => {
  const platform: PushPlatform = {
    permission: async () => ({ granted: true, canAsk: false }),
    ask: async () => true,
    isNew: () => false,
    token: async () => {
      throw new Error('no APNs on this simulator');
    },
  };
  assert.deepEqual(await registerPush(connection, platform, { projectId: PROJECT, fetch: fakeRelay().fetchFn }), {
    status: 'unavailable',
    reason: 'This phone gives no push token: no APNs on this simulator',
  });
  const broken = { ...platform, permission: () => Promise.reject('denied by MDM') };
  assert.equal(
    (await registerPush(connection, broken, { projectId: PROJECT, fetch: fakeRelay().fetchFn })).status,
    'unavailable',
  );
});

test('the answer of the relay: 401 is a session that ended, another refusal or no answer gives a line', async () => {
  const platform: PushPlatform = {
    permission: async () => ({ granted: true, canAsk: false }),
    ask: async () => true,
    isNew: () => false,
    token: async () => TOKEN,
  };
  const run = (answer: () => Response | Promise<Response>) =>
    registerPush(connection, platform, { projectId: PROJECT, fetch: fakeRelay(answer).fetchFn });
  assert.deepEqual(await run(() => new Response('{}', { status: 401 })), { status: 'expired' });
  assert.deepEqual(await run(() => Response.json({ error: 'This relay keeps no state' }, { status: 503 })), {
    status: 'failed',
    message: 'The relay refused the phone (503): This relay keeps no state',
  });
  assert.deepEqual(await run(() => new Response('oops', { status: 500 })), {
    status: 'failed',
    message: 'The relay refused the phone (500).',
  });
  assert.deepEqual(await run(() => Promise.reject(new TypeError('Network request failed'))), {
    status: 'failed',
    message: 'The relay did not answer. Try again later.',
  });
  const timeout = new Error('timed out');
  timeout.name = 'TimeoutError';
  assert.deepEqual(await run(() => Promise.reject(timeout)), {
    status: 'failed',
    message: 'The relay did not answer in 15 s.',
  });
});

test('the EAS project id comes from the config or the build, never the zero id of app.json', () => {
  assert.equal(projectIdOf({ eas: { projectId: PROJECT } }), PROJECT);
  assert.equal(projectIdOf({ eas: { projectId: '00000000-0000-0000-0000-000000000000' } }), undefined);
  assert.equal(
    projectIdOf({ eas: { projectId: '00000000-0000-0000-0000-000000000000' } }, { projectId: PROJECT }),
    PROJECT,
  );
  assert.equal(projectIdOf(undefined, null), undefined);
  assert.equal(projectIdOf({ eas: { projectId: 'not-a-uuid' } }), undefined);
  assert.equal(projectIdOf({ eas: 3 }, { projectId: 4 }), undefined);
});

test('the fake Expo of a demo must be on this machine', async () => {
  assert.equal(demoExpoUrl('http://localhost:4642/'), 'http://localhost:4642');
  assert.equal(demoExpoUrl('http://127.0.0.1:4642'), 'http://127.0.0.1:4642');
  for (const value of ['https://exp.host', 'http://evil.test', 'localhost:4642', 3, undefined])
    assert.equal(demoExpoUrl(value), undefined);
  const { module, calls } = mockNotifications({ status: 'granted' });
  await platformOf(module, 'ios', 'http://localhost:4642').token(PROJECT);
  assert.deepEqual(calls, [`token ${PROJECT} http://localhost:4642/--/api/v2/`]);
});

test('only a new device token asks for a new registration, not the one that the registration itself got', async () => {
  const { module } = mockNotifications({ status: 'granted' });
  const platform = platformOf(module, 'ios');
  // Before any registration, every token is new.
  assert.equal(platform.isNew('apns-1'), true);
  await platform.token(PROJECT);
  assert.equal(platform.isNew('apns-1'), false);
  assert.equal(platform.isNew('apns-2'), true);
});
