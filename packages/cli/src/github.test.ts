import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskCache } from './cache.js';
import {
  isRateLimited,
  mergeSearches,
  pointsOutUntil,
  QuotaError,
  readKey,
  readOrLast,
  searchScope,
  withUnfinishedRuns,
  type PullRequestSnapshot,
} from './github.js';
import { summarizeChecks } from './reviewers.js';

const result = (url: string, updatedAt: string, isDraft = false) => ({ url, updatedAt, isDraft });

test('the searches of several authors give one list: newest first, each pull request once, no draft', () => {
  const merged = mergeSearches([
    [result('a/1', '2026-10-01T10:00:00Z'), result('a/2', '2026-10-03T10:00:00Z', true)],
    [result('a/3', '2026-10-05T10:00:00Z'), result('a/1', '2026-10-01T10:00:00Z')],
  ]);
  assert.deepEqual(
    merged.map((pull) => pull.url),
    ['a/3', 'a/1'],
  );
});

test('a cached read without the fields of the merge policy does not answer a read that needs them', () => {
  const pr = { repo: 'acme/web', number: 1, title: '', url: '' };
  const keys = [
    readKey(pr, {}),
    readKey(pr, { threads: true }),
    readKey(pr, { files: true }),
    readKey(pr, { threads: true, files: true }),
    readKey(pr, { lineComments: true }),
  ];
  assert.equal(new Set(keys).size, 5);
  assert.equal(readKey(pr, { threads: false, files: false }), readKey(pr, {}));
});

test('the repositories replace the owner in the search, so a repository of another owner still counts', () => {
  assert.deepEqual(searchScope('acme', []), ['--owner', 'acme']);
  assert.deepEqual(searchScope('', []), []);
  assert.deepEqual(searchScope('acme', ['acme/web', 'other/api']), ['--repo', 'acme/web', '--repo', 'other/api']);
});

const suite = (workflow: string, run: number, status: string) => ({
  status,
  workflowRun: { databaseId: run, workflow: { name: workflow } },
});

test('a queued workflow run with no check yet runs, and only the last run of each workflow counts', () => {
  const checks = withUnfinishedRuns(
    [{ name: 'mutation', state: 'success', workflow: 'Mutation', run: 1 }],
    [
      suite('Mutation', 1, 'COMPLETED'),
      suite('CI', 2, 'QUEUED'),
      suite('Deploy', 3, 'QUEUED'),
      suite('Deploy', 4, 'COMPLETED'),
      { status: 'QUEUED', workflowRun: null },
    ],
  );
  assert.deepEqual(
    checks.map(({ name, state }) => [name, state]),
    [
      ['mutation', 'success'],
      ['CI', 'pending'],
    ],
  );
  assert.equal(summarizeChecks(checks, []).pending, 1);
});

test('a run between two jobs runs, and a run with a running check adds nothing', () => {
  const done = { name: 'build', state: 'success' as const, workflow: 'CI', run: 7 };
  assert.equal(withUnfinishedRuns([done], [suite('CI', 7, 'IN_PROGRESS')]).length, 2);
  const running = { name: 'test', state: 'pending' as const, workflow: 'CI', run: 7 };
  assert.equal(withUnfinishedRuns([done, running], [suite('CI', 7, 'IN_PROGRESS')]).length, 2);
});

test('a queued newer run replaces the checks of a cancelled run of the same workflow', () => {
  const cancelled = { name: 'test', state: 'failure' as const, workflow: 'CI', run: 1, cancelled: true };
  const checks = withUnfinishedRuns([cancelled], [suite('CI', 1, 'COMPLETED'), suite('CI', 2, 'QUEUED')]);
  const summary = summarizeChecks(checks, []);
  assert.deepEqual([summary.failed, summary.cancelled, summary.pending], [[], ['test'], 1]);
});

const cachedSnapshot = { status: 'open', head: 'old' } as PullRequestSnapshot;
const failing = (error: Error) => async (): Promise<PullRequestSnapshot> => {
  throw error;
};

test('a read that GitHub refuses for a rate limit gives the last cached read of any age, marked stale', async () => {
  const cache = new DiskCache(await mkdtemp(join(tmpdir(), 'boo-cache-')));
  const at = Date.parse('2026-10-27T08:00:00Z');
  await cache.set('pr', cachedSnapshot, at);
  const until = '2026-10-27T11:00:00Z';
  const read = await readOrLast(cache, 'pr', 30_000, failing(new QuotaError('rate limit', until)));
  assert.equal(read.head, 'old');
  assert.deepEqual(read.stale, { at: new Date(at).toISOString(), until });
  assert.equal((await cache.get<PullRequestSnapshot>('pr', Infinity))?.at, at);
});

test('a refused read with no cached read, or a read that fails for another reason, stays an error', async () => {
  const cache = new DiskCache(await mkdtemp(join(tmpdir(), 'boo-cache-')));
  await assert.rejects(readOrLast(cache, 'pr', 30_000, failing(new QuotaError('rate limit'))), QuotaError);
  await cache.set('pr', cachedSnapshot, Date.parse('2026-10-27T08:00:00Z'));
  await assert.rejects(readOrLast(cache, 'pr', 30_000, failing(new Error('no such pull request'))), /no such/);
});

test('a read that works is not stale, and the cache keeps it', async () => {
  const cache = new DiskCache(await mkdtemp(join(tmpdir(), 'boo-cache-')));
  const read = await readOrLast(cache, 'pr', 30_000, async () => ({ ...cachedSnapshot, head: 'new' }));
  assert.equal(read.stale, undefined);
  assert.equal((await cache.get<PullRequestSnapshot>('pr', 30_000))?.value.head, 'new');
});

test('the queries stop until the reset when fewer than 10 points remain', () => {
  const now = new Date('2026-10-27T10:00:00Z');
  const rate = (remaining: number, resetAt = '2026-10-27T11:00:00Z') => ({ limit: 5000, remaining, resetAt });
  assert.equal(pointsOutUntil(rate(9), now), '2026-10-27T11:00:00Z');
  assert.equal(pointsOutUntil(rate(10), now), undefined);
  assert.equal(pointsOutUntil(rate(0, '2026-10-27T09:59:00Z'), now), undefined);
  assert.equal(pointsOutUntil(undefined, now), undefined);
});

test('the primary and the secondary rate limits of GitHub are rate limits', () => {
  assert.equal(isRateLimited('gh: API rate limit exceeded for user ID 1.'), true);
  assert.equal(isRateLimited('You have exceeded a secondary rate limit. Please wait a few minutes.'), true);
  assert.equal(isRateLimited('Could not resolve to a PullRequest with the number of 9.'), false);
});
