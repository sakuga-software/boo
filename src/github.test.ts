import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSearches, readKey, searchScope } from './github.js';

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
  ];
  assert.equal(new Set(keys).size, 4);
  assert.equal(readKey(pr, { threads: false, files: false }), readKey(pr, {}));
});

test('the repositories replace the owner in the search, so a repository of another owner still counts', () => {
  assert.deepEqual(searchScope('acme', []), ['--owner', 'acme']);
  assert.deepEqual(searchScope('', []), []);
  assert.deepEqual(searchScope('acme', ['acme/web', 'other/api']), ['--repo', 'acme/web', '--repo', 'other/api']);
});
