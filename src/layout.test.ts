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
  assert.equal(layoutFor(119, DEFAULT_SETTINGS, true).counts, false);
  const medium = layoutFor(99, DEFAULT_SETTINGS, true);
  assert.deepEqual([medium.label, medium.shortChecks, medium.lastReview, medium.indent], [false, true, true, 5]);
  const small = layoutFor(79, DEFAULT_SETTINGS, true);
  assert.deepEqual([small.lastReview, small.shortBar, small.checks], [false, true, true]);
  assert.equal(layoutFor(59, DEFAULT_SETTINGS, true).checks, false);
});

test('a piped run ignores the width but keeps the settings', () => {
  const layout = layoutFor(40, { ...DEFAULT_SETTINGS, counts: false }, false);
  assert.deepEqual([layout.label, layout.checks, layout.counts, layout.indent], [true, true, false, 22]);
});

test('the row height follows the lines that the row shows', () => {
  const row = { summary: true, detail: true, posted: false };
  assert.equal(rowHeight(row, layoutFor(160, DEFAULT_SETTINGS, true)), 4);
  assert.equal(rowHeight(row, layoutFor(160, { ...DEFAULT_SETTINGS, compact: true, details: false }, true)), 2);
  assert.equal(rowHeight(row, layoutFor(70, { ...DEFAULT_SETTINGS, marks: false }, true)), 3);
  assert.equal(rowHeight({ summary: false, detail: false, posted: true }, layoutFor(160, DEFAULT_SETTINGS, true)), 3);
});
