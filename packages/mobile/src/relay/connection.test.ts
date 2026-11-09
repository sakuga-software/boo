import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConnection, withAbortReason } from './connection';

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
