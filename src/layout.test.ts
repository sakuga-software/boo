import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutFor, rowHeight } from './layout.js';
import { DEFAULT_SETTINGS } from './settings.js';

test('a wide terminal shows every part', () => {
  const layout = layoutFor(160, DEFAULT_SETTINGS, true);
  assert.deepEqual(
    [layout.label, layout.checks, layout.shortChecks, layout.counts, layout.lastReview, layout.marks, layout.shortBar],
    [true, true, false, true, true, true, false],
  );
  assert.equal(layout.indent, 24);
});

test('a narrow terminal drops the parts from the least useful', () => {
  assert.equal(layoutFor(100, DEFAULT_SETTINGS, true).shortBar, false);
  const medium = layoutFor(99, DEFAULT_SETTINGS, true);
  assert.deepEqual(
    [medium.label, medium.shortChecks, medium.agentName, medium.shortBar, medium.lastReview, medium.indent],
    [false, true, false, true, true, 5],
  );
  const small = layoutFor(79, DEFAULT_SETTINGS, true);
  assert.deepEqual([small.lastReview, small.stack, small.shortBar, small.checks], [false, false, true, true]);
  assert.equal(layoutFor(59, DEFAULT_SETTINGS, true).checks, false);
});

test('a piped run ignores the width but keeps the settings', () => {
  const layout = layoutFor(40, { ...DEFAULT_SETTINGS, counts: false }, false);
  assert.deepEqual([layout.label, layout.checks, layout.counts, layout.indent], [true, true, false, 22]);
});

test('a folded row takes one line, and an unfolded row adds its details', () => {
  const wide = layoutFor(160, DEFAULT_SETTINGS, true);
  const row = { summary: true, agent: true, unfolded: false, detail: true, posted: false };
  assert.equal(rowHeight(row, wide), 2);
  assert.equal(rowHeight({ ...row, unfolded: true }, wide), 5);
  assert.equal(rowHeight({ ...row, unfolded: true, agent: false }, wide), 4);
  assert.equal(
    rowHeight({ ...row, unfolded: true }, layoutFor(160, { ...DEFAULT_SETTINGS, compact: true, details: false }, true)),
    3,
  );
  assert.equal(rowHeight({ ...row, posted: true }, wide), 3);
  const noReviewers = { ...DEFAULT_SETTINGS, counts: false, lastReview: false, marks: false, agent: false };
  assert.equal(rowHeight({ ...row, unfolded: true }, layoutFor(160, noReviewers, true)), 3);
});
