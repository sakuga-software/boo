import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PullRequestSnapshot } from '@sakuga-software/boo-core/github';
import { DEFAULT_SETTINGS } from '@sakuga-software/boo-core/settings';
import { KEEP_AFTER_CLOSE_MS, StateStore } from './state-store.js';

const DAY = 24 * 60 * 60_000;
const pr = (number: number, repo = 'acme/web') => ({
  repo,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
});
const snapshot = (status: PullRequestSnapshot['status'], head = 'head1'): PullRequestSnapshot => ({
  status,
  head,
  branch: 'feature',
  fork: false,
  base: 'main',
  defaultBranch: 'main',
  author: 'alice',
  mergeState: 'clean',
  reviews: [],
  comments: [
    {
      id: 1,
      user: { login: 'bob' },
      body: 'a secret review text',
      created_at: '2026-11-09T10:00:00Z',
      updated_at: '2026-11-09T10:00:00Z',
    },
  ],
  checks: [],
  requested: [],
  body: 'the description',
});

const fileStore = async () => join(await mkdtemp(join(tmpdir(), 'relay-state-')), 'data', 'state.db');

test('the config of a user and the reads survive a restart', async () => {
  const file = await fileStore();
  const first = new StateStore(file);
  first.setConfig('Alice', { org: 'acme', settings: { ...DEFAULT_SETTINGS, authors: ['@me', 'bob'] } }, 1);
  first.savePull(pr(1), { snapshot: snapshot('open') }, 10);
  first.setFollows('alice', [pr(1)], 10);
  first.close();

  const second = new StateStore(file);
  assert.deepEqual(second.config('alice')?.settings.authors, ['@me', 'bob']);
  assert.deepEqual(second.logins(), ['alice']);
  const [stored] = second.pullsOf('ALICE');
  assert.equal(stored?.snapshot?.head, 'head1');
  assert.equal(stored?.readAt, 10);
  second.close();
});

test('the last write of a config wins', () => {
  const store = new StateStore(':memory:');
  store.setConfig('alice', { org: 'acme', settings: DEFAULT_SETTINGS }, 1);
  store.setConfig('alice', { org: '', settings: DEFAULT_SETTINGS }, 2);
  assert.equal(store.config('alice')?.org, '');
  assert.equal(store.config('bob'), undefined);
});

test('a failed read keeps the last snapshot with the error, and a read that works clears the error', () => {
  const store = new StateStore(':memory:');
  store.savePull(pr(1), { error: 'GitHub answered 502' }, 1);
  assert.deepEqual(store.pull(pr(1)), { pr: pr(1), error: 'GitHub answered 502', readAt: 1 });
  store.savePull(pr(1), { snapshot: snapshot('open') }, 2);
  store.savePull(pr(1), { error: 'GitHub answered 502' }, 3);
  const kept = store.pull(pr(1));
  assert.equal(kept?.snapshot?.status, 'open');
  assert.equal(kept?.error, 'GitHub answered 502');
  store.savePull(pr(1), { snapshot: snapshot('open') }, 4);
  assert.equal(store.pull(pr(1))?.error, undefined);
});

test('a status webhook finds the pull requests by their head commit', () => {
  const store = new StateStore(':memory:');
  store.savePull(pr(1), { snapshot: snapshot('open', 'abc') }, 1);
  store.savePull(pr(2), { snapshot: snapshot('open', 'def') }, 1);
  store.savePull(pr(3, 'acme/api'), { snapshot: snapshot('open', 'abc') }, 1);
  assert.deepEqual(
    store.pullsWithHead('Acme/Web', 'abc').map((found) => found.number),
    [1],
  );
});

test('a pull request is stored once for all its users, and each user reads only what it follows', () => {
  const store = new StateStore(':memory:');
  store.savePull(pr(1), { snapshot: snapshot('open') }, 1);
  store.savePull(pr(2), { snapshot: snapshot('open') }, 1);
  store.setFollows('alice', [pr(1), pr(2)], 1);
  store.setFollows('bob', [pr(2)], 1);
  assert.deepEqual(
    store.pullsOf('alice').map((stored) => stored.pr.number),
    [1, 2],
  );
  assert.deepEqual(
    store.pullsOf('bob').map((stored) => stored.pr.number),
    [2],
  );
  assert.deepEqual(
    store.pullsOf('alice', new Set(['acme/api'])).map((stored) => stored.pr.number),
    [],
    'a repository that the user no longer reads is filtered out',
  );
  assert.equal(store.followed(pr(2)), true);
  store.setFollows('bob', [], 2);
  assert.equal(store.followed(pr(2)), true, 'alice still follows it');
});

test('D9: the text of a pull request is deleted 7 days after it closes, not before', () => {
  const store = new StateStore(':memory:');
  store.savePull(pr(1), { snapshot: snapshot('open') }, 0);
  store.setFollows('alice', [pr(1)], 0);
  const closedAt = 5 * DAY;
  store.savePull(pr(1), { snapshot: snapshot('merged') }, closedAt);
  // A later read of the merged pull request does not move the time of the close.
  store.savePull(pr(1), { snapshot: snapshot('merged') }, closedAt + DAY);
  assert.equal(store.purge(closedAt + KEEP_AFTER_CLOSE_MS - 1), 0);
  assert.ok(store.pull(pr(1)));
  assert.equal(store.purge(closedAt + KEEP_AFTER_CLOSE_MS), 1);
  assert.equal(store.pull(pr(1)), undefined);
  assert.deepEqual(store.pullsOf('alice'), []);
});

test('a pull request that is open again is not deleted', () => {
  const store = new StateStore(':memory:');
  store.setFollows('alice', [pr(1)], 0);
  store.savePull(pr(1), { snapshot: snapshot('closed') }, 0);
  store.savePull(pr(1), { snapshot: snapshot('open') }, DAY);
  assert.equal(store.purge(30 * DAY), 0);
});

test('a pull request that nobody follows for 7 days is deleted, and one followed again is kept', () => {
  const store = new StateStore(':memory:');
  store.savePull(pr(1), { snapshot: snapshot('open') }, 0);
  store.savePull(pr(2), { snapshot: snapshot('open') }, 0);
  store.setFollows('alice', [pr(1), pr(2)], 0);
  store.setFollows('alice', [pr(1)], DAY);
  store.setFollows('alice', [pr(1), pr(2)], 2 * DAY);
  store.setFollows('alice', [pr(1)], 3 * DAY);
  assert.equal(store.purge(3 * DAY + KEEP_AFTER_CLOSE_MS - 1), 0);
  assert.equal(store.purge(3 * DAY + KEEP_AFTER_CLOSE_MS), 1);
  assert.ok(store.pull(pr(1)));
  assert.equal(store.pull(pr(2)), undefined);
});
