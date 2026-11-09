import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSettings } from '@sakuga-software/boo-core/settings';
import { readSettings, writeSettings } from './remote';

const connection = { url: 'https://relay.test', session: 'sess', login: 'alice' };
const config = { org: 'acme', settings: parseSettings({ authors: ['@me'], repos: ['acme/api'], drafts: 'show' }) };

function relay(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

test('a read sends the session token to the relay of the connection, and refuses a redirect', async () => {
  const fake = relay(200, config);
  assert.deepEqual(await readSettings(connection, fake.fetchFn), { status: 'ok', config });
  const [call] = fake.calls;
  assert.equal(call!.url, 'https://relay.test/settings');
  assert.equal(call!.init.method, 'GET');
  assert.equal(call!.init.redirect, 'error');
  assert.equal((call!.init.headers as Record<string, string>).authorization, 'Bearer sess');
});

test('a write sends the whole settings file with org beside it', async () => {
  const fake = relay(200, config);
  assert.deepEqual(await writeSettings(connection, fake.fetchFn, config), { status: 'ok', config });
  const [call] = fake.calls;
  assert.equal(call!.init.method, 'PUT');
  assert.equal((call!.init.headers as Record<string, string>)['content-type'], 'application/json');
  assert.equal((call!.init.headers as Record<string, string>).authorization, 'Bearer sess');
  const body = JSON.parse(call!.init.body as string) as Record<string, unknown>;
  assert.equal(body.org, 'acme');
  assert.deepEqual(body.repos, ['acme/api']);
  assert.equal(body.drafts, 'show');
  assert.equal('settings' in body, false);
});

test('a 401 is an expired session; another refusal, a wrong answer or no answer gives a line', async () => {
  assert.deepEqual(await readSettings(connection, relay(401, { error: 'No session' }).fetchFn), {
    status: 'expired',
  });
  assert.deepEqual(await writeSettings(connection, relay(400, { error: 'org must be a login' }).fetchFn, config), {
    status: 'failed',
    message: 'The relay refused the settings (400): org must be a login',
  });
  assert.deepEqual(await readSettings(connection, relay(503, 'Service Unavailable').fetchFn), {
    status: 'failed',
    message: 'The relay refused the settings (503).',
  });
  assert.deepEqual(await readSettings(connection, relay(200, { hello: 'world' }).fetchFn), {
    status: 'failed',
    message: 'The answer of the relay is not a settings file.',
  });
  const down = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  assert.deepEqual(await readSettings(connection, down), {
    status: 'failed',
    message: 'The relay did not answer. Try again later.',
  });
});

test('a relay that never answers stops the call after the timeout', async () => {
  const quiet = ((_url: string, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('cancelled')));
    })) as unknown as typeof fetch;
  assert.deepEqual(await readSettings(connection, quiet, 20), {
    status: 'failed',
    message: 'The relay did not answer in 0.02 s.',
  });
});
