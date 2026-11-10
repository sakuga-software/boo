import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRules } from './merge-rules';
import { report } from './report-fixture';

test('a pull request ready to merge passes each rule of the sheet', () => {
  assert.deepEqual(mergeRules(report({ threads: { open: 0, answered: 4 } })), [
    { label: 'Checks passed', ok: true, value: '3/3' },
    { label: 'Review score', ok: true, value: '4/5', score: { score: 4, total: 5 } },
    { label: 'Bot threads answered', ok: true, value: '4/4' },
    { label: 'Approved', ok: true, value: 'kento-review', approver: 'kento-review[bot]' },
    { label: 'No conflicts with main', ok: true, value: '' },
  ]);
});

test('a rule that fails shows as missed, with the other rules of the policy', () => {
  const rules = mergeRules(
    report({
      state: 'conflicts',
      reviewers: [],
      checks: { ...report().checks, passed: 2, failing: ['e2e'] },
      policy: [
        { rule: 'minScore', note: 'no score from sakuga-review' },
        { rule: 'ownerOnly', note: 'needs the review of mheaus' },
      ],
    }),
  );
  assert.deepEqual(
    rules.map(({ label, ok, value }) => [label, ok, value]),
    [
      ['Checks passed', false, '2/3'],
      ['Review score', false, 'none'],
      ['Approved', false, 'nobody yet'],
      ['No conflicts with main', false, ''],
      ['Needs the review of mheaus', false, ''],
    ],
  );
});
