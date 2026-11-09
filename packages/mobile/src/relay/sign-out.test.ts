import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signOutOnce } from './sign-out';

const connection = { url: 'https://relay.test', session: 'sess', login: 'alice' };

function relay() {
  const calls: string[] = [];
  let forgotten = 0;
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? 'GET'} ${input}`);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, fetchFn, forget: async () => void forgotten++, forgotten: () => forgotten };
}

test('two taps on Sign out before the screen renders send one DELETE /sessions (#55f5ef)', async () => {
  const fake = relay();
  const signOut = signOutOnce({ fetch: fake.fetchFn, forget: fake.forget });
  // The second tap comes in the same tick as the first one: no render between them.
  const first = signOut(connection);
  const second = signOut({ ...connection });
  await Promise.all([first, second]);
  assert.deepEqual(fake.calls, ['DELETE https://relay.test/sessions']);
  assert.equal(fake.forgotten(), 1);
  assert.equal(first, second);
});

test('a sign-out after the end of the first one, or of another session, runs again', async () => {
  const fake = relay();
  const signOut = signOutOnce({ fetch: fake.fetchFn, forget: fake.forget });
  await signOut(connection);
  await Promise.all([signOut(connection), signOut({ ...connection, session: 'other' })]);
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.forgotten(), 3);
});

test('a relay that does not answer, or a store that fails, still ends the sign-out', async () => {
  const down = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  let forgotten = 0;
  const signOut = signOutOnce({
    fetch: down,
    forget: async () => {
      forgotten++;
      throw new Error('keychain locked');
    },
  });
  await signOut(connection);
  assert.equal(forgotten, 1);
  // The failed run does not block the next one.
  await signOut(connection);
  assert.equal(forgotten, 2);
});
