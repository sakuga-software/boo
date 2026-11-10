import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readState } from './read-state';
import { report } from './report-fixture';

const connection = { url: 'https://relay.test', session: 'sess', login: 'alice' };
const state = { cursor: 'abcd-1', at: '2026-11-09T11:00:00.000Z', reports: [report()] };

function answer(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

test('the list comes from GET /state with the session token, and never follows a redirect', async () => {
  const { calls, fetchFn } = answer(200, state);
  assert.deepEqual(await readState(connection, fetchFn), { status: 'read', state });
  assert.equal(calls[0]!.url, 'https://relay.test/state');
  assert.deepEqual(calls[0]!.init.headers, { authorization: 'Bearer sess' });
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
});

test('a 401 is a session that the relay no longer knows, whatever its text', async () => {
  assert.deepEqual(await readState(connection, answer(401, { error: 'anything' }).fetchFn), { status: 'expired' });
});

test('another refusal gives the status and the error of the relay', async () => {
  assert.deepEqual(
    await readState(
      connection,
      answer(503, { error: 'This relay keeps no state: it needs GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY' }).fetchFn,
    ),
    {
      status: 'failed',
      message:
        'The relay refused the list: 503 This relay keeps no state: it needs GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY',
    },
  );
  assert.deepEqual(await readState(connection, answer(502, '<html>').fetchFn), {
    status: 'failed',
    message: 'The relay refused the list: 502',
  });
});

test('an answer that is not a list of reports fails', async () => {
  for (const body of ['not json', { cursor: 'c', at: 'now' }, null])
    assert.deepEqual(await readState(connection, answer(200, body).fetchFn), {
      status: 'failed',
      message: 'The relay gave a list that the app cannot read.',
    });
});

test('a relay that does not answer in time, or a network that fails, gives a failure to show', async (t) => {
  // The timer of AbortSignal.timeout does not hold the event loop, and the fake holds nothing: Node 22 can end the test first.
  const hold = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(hold));
  const hangs = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) =>
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
    )) as unknown as typeof fetch;
  assert.deepEqual(await readState(connection, hangs, 10), {
    status: 'failed',
    message: 'The relay did not answer in 0.01 s.',
  });
  const offline = (async () => {
    throw new TypeError('Network request failed');
  }) as unknown as typeof fetch;
  assert.deepEqual(await readState(connection, offline), {
    status: 'failed',
    message: 'The relay cannot be reached. Check the network.',
  });
});
