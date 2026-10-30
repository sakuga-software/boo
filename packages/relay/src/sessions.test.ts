import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sessionId, SessionStore } from './sessions.js';

const user = { id: 1, login: 'alice' };
const tokens = { accessToken: 'ghu_secret', refreshToken: 'ghr_secret', expiresAt: 1_000 };

test('a session survives a restart, and the file keeps no token in clear', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'relay-')), 'data', 'sessions.json');
  const store = new SessionStore(file, 'key');
  const { token, session } = await store.create(user, tokens);
  assert.equal(session.id, sessionId(token));

  const text = await readFile(file, 'utf8');
  assert.doesNotMatch(text, /ghu_secret|ghr_secret/);
  assert.doesNotMatch(text, new RegExp(token));
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const restarted = new SessionStore(file, 'key');
  await restarted.load();
  assert.deepEqual(restarted.byToken(token)?.tokens, tokens);
  assert.equal(restarted.byToken('other'), undefined);
});

test('a store with another key cannot read the tokens', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'relay-')), 'sessions.json');
  await new SessionStore(file, 'key').create(user, tokens);
  await assert.rejects(new SessionStore(file, 'other key').load());
});

test('an update and a delete reach the file', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'relay-')), 'sessions.json');
  const store = new SessionStore(file, 'key');
  await store.load();
  const { token, session } = await store.create(user, tokens);
  await store.update(session.id, { accessToken: 'ghu_new' });
  await store.update('unknown', { accessToken: 'ignored' });
  let restarted = new SessionStore(file, 'key');
  await restarted.load();
  assert.deepEqual(restarted.byToken(token)?.tokens, { accessToken: 'ghu_new' });

  await store.delete(session.id);
  await store.delete(session.id);
  restarted = new SessionStore(file, 'key');
  await restarted.load();
  assert.equal(restarted.byToken(token), undefined);
});
