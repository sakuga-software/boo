import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRelay, relayUrl, removeWebhooks, SetupError, setupWebhooks, type SetupDeps } from './webhooks.js';

interface Call {
  url: string;
  method: string;
  body?: string;
  authorization?: string;
}

type Answer = { status?: number; body: unknown };

/** A fake network: each URL answers from its queue, and the last answer of a queue repeats. */
function fakeNetwork(routes: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url: input,
      method: init.method ?? 'GET',
      ...(typeof init.body === 'string' && { body: init.body }),
      ...(headers.authorization && { authorization: headers.authorization }),
    });
    const key = `${init.method ?? 'GET'} ${input}`;
    const queue = routes[key];
    if (!queue) throw new Error(`no route for ${key}`);
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const RELAY = 'https://relay.test';
const relayRoot: Answer = {
  body: { name: 'boo-relay', clientId: 'Iv1.app', installUrl: 'https://github.com/apps/boo-relay/installations/new' },
};
const deviceCode: Answer = {
  body: {
    device_code: 'dc',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  },
};
const granted: Answer = { body: { access_token: 'ghu_x', refresh_token: 'ghr_x', expires_in: 28_800 } };
const installed: Answer = { body: { installations: [{ id: 1, account: 'acme' }], installUrl: relayRoot.body } };

async function deps(fetchFn: typeof fetch, extra: Partial<SetupDeps> = {}) {
  const lines: string[] = [];
  const opened: string[] = [];
  let clock = 0;
  const value: SetupDeps = {
    fetch: fetchFn,
    open: async (url) => void opened.push(url),
    log: (line) => void lines.push(line),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    path: join(await mkdtemp(join(tmpdir(), 'boo-relay-')), 'boo', 'relay.json'),
    ...extra,
  };
  return { value, lines, opened };
}

const routes = (token: Answer[], installations: Answer[] = [installed]): Record<string, Answer[]> => ({
  [`GET ${RELAY}`]: [relayRoot],
  'POST https://github.com/login/device/code': [deviceCode],
  'POST https://github.com/login/oauth/access_token': token,
  [`POST ${RELAY}/sessions`]: [{ status: 201, body: { session: 'sess', login: 'alice' } }],
  [`GET ${RELAY}/installations`]: installations,
});

test('a relay URL gets https and loses its trailing slash, and none gives the hosted relay', () => {
  assert.equal(relayUrl('relay.example.com/'), 'https://relay.example.com');
  assert.equal(relayUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(relayUrl(undefined), 'https://boo-relay.sakuga.dev');
});

test('the setup signs in with the device flow, opens a session, and saves it for the owner only', async () => {
  const { calls, fetchFn } = fakeNetwork(routes([{ body: { error: 'authorization_pending' } }, granted]));
  const { value, lines, opened } = await deps(fetchFn);
  const connection = await setupWebhooks(`${RELAY}/`, value);
  assert.deepEqual(connection, { url: RELAY, session: 'sess', login: 'alice' });
  assert.ok(lines.includes('Open https://github.com/login/device and type the code ABCD-1234'));
  assert.ok(lines.includes('Installed on acme'));
  assert.deepEqual(opened, ['https://github.com/login/device']);

  const session = calls.find((call) => call.url === `${RELAY}/sessions`)!;
  assert.deepEqual(JSON.parse(session.body!), { accessToken: 'ghu_x', refreshToken: 'ghr_x', expiresIn: 28_800 });
  assert.equal(calls.find((call) => call.url.endsWith('/installations'))!.authorization, 'Bearer sess');
  assert.match(calls.find((call) => call.url.endsWith('/device/code'))!.body!, /client_id=Iv1\.app/);

  assert.deepEqual(await loadRelay(value.path), connection);
  assert.equal((await stat(value.path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(value.path, 'utf8'), /ghu_x|ghr_x/);
});

test('a slow_down makes the poll wait longer', async () => {
  const { fetchFn } = fakeNetwork(routes([{ body: { error: 'slow_down', interval: 10 } }, granted]));
  const sleeps: number[] = [];
  const { value } = await deps(fetchFn);
  const sleep = value.sleep;
  value.sleep = async (ms) => {
    sleeps.push(ms);
    await sleep(ms);
  };
  await setupWebhooks(RELAY, value);
  assert.deepEqual(sleeps.slice(0, 2), [5_000, 10_000]);
});

test('a denied authorization, an expired code or another error stops the setup and saves nothing', async () => {
  for (const [answer, message] of [
    [{ body: { error: 'access_denied' } }, /denied/],
    [{ body: { error: 'expired_token' } }, /expired/],
    [{ body: { error: 'incorrect_client_credentials' } }, /incorrect_client_credentials/],
  ] as const) {
    const { fetchFn } = fakeNetwork(routes([answer]));
    const { value } = await deps(fetchFn);
    await assert.rejects(
      setupWebhooks(RELAY, value),
      (error) => error instanceof SetupError && message.test(error.message),
    );
    assert.equal(await loadRelay(value.path), undefined);
  }
});

test('a code that nobody types before its end stops the setup', async () => {
  const { fetchFn } = fakeNetwork(routes([{ body: { error: 'authorization_pending' } }]));
  const { value } = await deps(fetchFn);
  await assert.rejects(setupWebhooks(RELAY, value), /expired before the authorization/);
});

test('with no installation, the setup opens the install page and waits for one', async () => {
  const none: Answer = {
    body: { installations: [], installUrl: 'https://github.com/apps/boo-relay/installations/new' },
  };
  const { fetchFn } = fakeNetwork(routes([granted], [none, none, installed]));
  const { value, lines, opened } = await deps(fetchFn);
  await setupWebhooks(RELAY, value);
  assert.ok(opened.includes('https://github.com/apps/boo-relay/installations/new'));
  assert.ok(lines.some((line) => line.startsWith('Install the App')));
  assert.ok(lines.includes('Installed on acme'));
});

test('an installation that never comes still saves the setup, and says so', async () => {
  const none: Answer = {
    body: { installations: [], installUrl: 'https://github.com/apps/boo-relay/installations/new' },
  };
  const { fetchFn } = fakeNetwork(routes([granted], [none]));
  const { value, lines } = await deps(fetchFn);
  await setupWebhooks(RELAY, value);
  assert.ok(lines.some((line) => line.startsWith('No installation yet')));
  assert.ok(await loadRelay(value.path));
});

test('a URL that is not a relay, or a relay that does not answer, stops the setup', async () => {
  const notRelay = fakeNetwork({ [`GET ${RELAY}`]: [{ body: { hello: 'world' } }] });
  await assert.rejects(setupWebhooks(RELAY, (await deps(notRelay.fetchFn)).value), /is not a boo relay/);
  const webSite = (async () => new Response('<!doctype html><title>Example</title>')) as unknown as typeof fetch;
  await assert.rejects(setupWebhooks(RELAY, (await deps(webSite)).value), /relay\.test is not a boo relay/);
  const down = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  await assert.rejects(
    setupWebhooks(RELAY, (await deps(down)).value),
    /No relay answers at https:\/\/relay\.test: ECONNREFUSED/,
  );
  const refused = fakeNetwork({
    ...routes([granted]),
    [`POST ${RELAY}/sessions`]: [{ status: 401, body: { error: 'not this App' } }],
  });
  await assert.rejects(
    setupWebhooks(RELAY, (await deps(refused.fetchFn)).value),
    /refused the session: 401 not this App/,
  );
});

test('the removal deletes the session on the relay, then the file, even if the relay does not answer', async () => {
  const { calls, fetchFn } = fakeNetwork(routes([granted]));
  const { value } = await deps(fetchFn);
  await setupWebhooks(RELAY, value);
  calls.length = 0;
  const removed = await removeWebhooks({
    fetch: fakeNetwork({ [`DELETE ${RELAY}/sessions`]: [{ status: 204, body: {} }] }).fetchFn,
    log: () => {},
    path: value.path,
  });
  assert.equal(removed, true);
  assert.equal(await loadRelay(value.path), undefined);
  assert.equal(await removeWebhooks({ fetch: fetchFn, log: () => {}, path: value.path }), false);

  await writeFile(value.path, JSON.stringify({ url: RELAY, session: 's', login: 'a' }));
  const lines: string[] = [];
  const down = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  assert.equal(await removeWebhooks({ fetch: down, log: (line) => void lines.push(line), path: value.path }), true);
  assert.equal(await loadRelay(value.path), undefined);
  assert.match(lines[0]!, /did not answer/);
});
