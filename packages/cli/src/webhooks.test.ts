import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadRelay, removeWebhooks, setupWebhooks, type SetupDeps } from './webhooks.js';

// The device flow, the session and the installations are tested in core (relay.test.ts). These
// tests cover what the CLI adds: the file of the connection.

const RELAY = 'https://relay.test';
const answers: Record<string, unknown> = {
  [`GET ${RELAY}`]: { name: 'boo-relay', clientId: 'Iv1.app', installUrl: 'https://github.com/apps/boo-relay' },
  'POST https://github.com/login/device/code': {
    device_code: 'dc',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  },
  'POST https://github.com/login/oauth/access_token': { access_token: 'ghu_x', refresh_token: 'ghr_x' },
  [`POST ${RELAY}/sessions`]: { session: 'sess', login: 'alice' },
  [`GET ${RELAY}/installations`]: { installations: [{ id: 1, account: 'acme' }], installUrl: '' },
  [`DELETE ${RELAY}/sessions`]: {},
};
const deletes: string[] = [];
const fetchFn = (async (input: string, init: RequestInit = {}) => {
  const key = `${init.method ?? 'GET'} ${input}`;
  if (key.startsWith('DELETE')) deletes.push(key);
  if (!(key in answers)) throw new Error(`no route for ${key}`);
  return new Response(JSON.stringify(answers[key]));
}) as typeof fetch;

async function deps(): Promise<SetupDeps> {
  let clock = 0;
  return {
    fetch: fetchFn,
    open: async () => {},
    log: () => {},
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    path: join(await mkdtemp(join(tmpdir(), 'boo-relay-')), 'boo', 'relay.json'),
  };
}

test('the setup saves the connection for the owner only, with no GitHub token', async () => {
  const value = await deps();
  const connection = await setupWebhooks(RELAY, value);
  assert.deepEqual(connection, { url: RELAY, session: 'sess', login: 'alice' });
  assert.deepEqual(await loadRelay(value.path), connection);
  assert.equal((await stat(value.path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(value.path, 'utf8'), /ghu_x|ghr_x/);
});

test('a file that the owner could read before keeps the mode of the owner only', async () => {
  const value = await deps();
  await mkdir(dirname(value.path), { recursive: true });
  await writeFile(value.path, '{}', { mode: 0o644 });
  await setupWebhooks(RELAY, value);
  assert.equal((await stat(value.path)).mode & 0o777, 0o600);
});

test('a setup that fails saves nothing', async () => {
  const value = await deps();
  await assert.rejects(setupWebhooks('http://relay.test', value), /is not HTTPS/);
  assert.equal(await loadRelay(value.path), undefined);
});

test('the removal deletes the session on the relay, then the file, even if the relay does not answer', async () => {
  const value = await deps();
  await setupWebhooks(RELAY, value);
  deletes.length = 0;
  assert.equal(await removeWebhooks({ fetch: fetchFn, log: () => {}, path: value.path }), true);
  assert.deepEqual(deletes, [`DELETE ${RELAY}/sessions`]);
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

test('a broken or partial file is no connection', async () => {
  const value = await deps();
  await mkdir(dirname(value.path), { recursive: true });
  for (const text of ['{', JSON.stringify({ url: RELAY, session: 's' })]) {
    await writeFile(value.path, text);
    assert.equal(await loadRelay(value.path), undefined);
  }
});
