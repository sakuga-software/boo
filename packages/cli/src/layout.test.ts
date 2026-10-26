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

test('a row takes one line, its details, its last post and the gap', () => {
  const wide = layoutFor(160, DEFAULT_SETTINGS, true);
  assert.equal(rowHeight({ details: 0, posted: false }, wide), 2);
  assert.equal(rowHeight({ details: 6, posted: true }, wide), 9);
  assert.equal(
    rowHeight({ details: 0, posted: false }, layoutFor(160, { ...DEFAULT_SETTINGS, compact: true }, true)),
    1,
  );
});
