import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSession, parseConnection, withAbortReason } from './connection';

test('a stored connection is read only when it is whole', () => {
  const connection = { url: 'https://relay.test', session: 's', login: 'alice' };
  assert.deepEqual(parseConnection(JSON.stringify({ ...connection, extra: 1 })), connection);
  assert.equal(parseConnection(null), undefined);
  assert.equal(parseConnection('{'), undefined);
  assert.equal(parseConnection(JSON.stringify({ url: 'https://relay.test', session: 's' })), undefined);
});

test('a call that its signal stopped fails with the reason of the signal, and another failure stays', async () => {
  const native = (async () => {
    throw new Error('the native request was cancelled');
  }) as unknown as typeof fetch;
  const wrapped = withAbortReason(native);
  const controller = new AbortController();
  const reason = new DOMException('The signal timed out.', 'TimeoutError');
  controller.abort(reason);
  await assert.rejects(
    wrapped('https://relay.test', { signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  await assert.rejects(wrapped('https://relay.test'), /native request was cancelled/);
  await assert.rejects(wrapped('https://relay.test', { signal: new AbortController().signal }), /cancelled/);
});

test('a session check reads the installations, and tells a 401 from a relay that cannot answer', async () => {
  const connection = { url: 'https://relay.test', session: 's', login: 'alice' };
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const installUrl = 'https://github.com/apps/boo-relay/installations/new';
  assert.deepEqual(
    await checkSession(connection, answer(200, { installations: [{ id: 1, account: 'acme' }], installUrl })),
    { status: 'read' },
  );
  assert.deepEqual(await checkSession(connection, answer(200, { installations: [], installUrl })), {
    status: 'read',
    installUrl,
  });
  // The text of the error is not read: a 401 with any message is an expired session.
  assert.deepEqual(await checkSession(connection, answer(401, { error: 'anything' })), { status: 'expired' });
  assert.deepEqual(await checkSession(connection, answer(500, { error: 'No session' })), { status: 'unknown' });
  const down = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  assert.deepEqual(await checkSession(connection, down), { status: 'unknown' });
});
