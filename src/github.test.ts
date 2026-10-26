import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSearches, readKey, searchScope, withUnfinishedRuns } from './github.js';
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
