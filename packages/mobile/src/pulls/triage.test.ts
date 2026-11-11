import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OVERALL_LABELS } from '@sakuga-software/boo-core/report';
import { report } from './report-fixture';
import {
  bestScore,
  groupOf,
  reviewerGlyph,
  rowMeta,
  shortName,
  stateGlyph,
  stateWords,
  triage,
  type Group,
} from './triage';

const at = new Date('2026-11-10T14:00:00.000Z');

test('each state of the terminal goes to one group: the person acts, merges, or waits for the reviewers', () => {
  const groups = Object.fromEntries(Object.values(OVERALL_LABELS).map((state) => [state, groupOf({ state })]));
  assert.deepEqual(groups, {
    conflicts: 'needs',
    'changes requested': 'needs',
    'checks failing': 'needs',
    'reviewer error': 'reviewing',
    'ready to merge': 'ready',
    approved: 'reviewing',
    reviewing: 'reviewing',
    reviewed: 'reviewing',
    quota: 'reviewing',
    'awaiting review': 'reviewing',
  } satisfies Record<string, Group>);
  assert.equal(groupOf({ state: 'error' }), 'needs');
  assert.equal(groupOf({ state: 'draft' }), 'reviewing');
  assert.equal(groupOf({ state: 'merged' }), undefined);
  assert.equal(groupOf({ state: 'closed' }), undefined);
});

test('the list keeps the order of the relay in each group, and counts the merges of the day only', () => {
  const list = [
    report({ number: 1, state: 'checks failing' }),
    report({ number: 2, state: 'ready to merge' }),
    report({ number: 3, state: 'reviewing' }),
    report({ number: 4, state: 'conflicts' }),
    report({ number: 5, state: 'merged', mergedAt: '2026-11-10T09:00:00.000Z' }),
    report({ number: 6, state: 'merged', mergedAt: '2026-11-08T09:00:00.000Z' }),
    report({ number: 7, state: 'closed' }),
  ];
  const groups = triage(list, at);
  assert.deepEqual(
    [groups.needs, groups.ready, groups.reviewing].map((rows) => rows.map(({ number }) => number)),
    [[1, 4], [2], [3]],
  );
  assert.equal(groups.mergedToday, 1);
});

test('a row names the repository without its owner', () => {
  assert.equal(shortName(report({ repo: 'sakuga-software/web', number: 921 })), 'web#921');
});

test('the state words count the failing checks and the reviewers on the head, and say when a quota ends', () => {
  const failing = report({
    state: 'checks failing',
    checks: {
      ...report().checks,
      failing: ['e2e', 'kento'],
      reviewerErrors: [{ check: 'kento', error: null }],
    },
  });
  assert.equal(stateWords(failing), '1 check failing');
  const reviewing = report({
    state: 'reviewing',
    reviewers: [
      { ...report().reviewers[0]!, onHead: true },
      { ...report().reviewers[0]!, login: 'copilot', onHead: false, mark: 'requested' },
    ],
  });
  assert.equal(stateWords(reviewing), 'reviewing 1/2');
  const back = new Date(2026, 10, 10, 15, 40).toISOString();
  const quota = report({
    state: 'quota',
    notes: { merge: null, retries: [], coderabbit: { kind: 'wait', availableAt: back, delayGuessed: false } },
  });
  assert.equal(stateWords(quota), 'quota · back 15:40');
  assert.equal(stateWords(report({ state: 'error' })), 'not read');
  assert.equal(stateWords(report({ state: 'conflicts' })), 'conflicts');
});

test('the meta of a row says the place, the age of the head, the score of a ready one, and a merged parent', () => {
  const ready = report({ repo: 'acme/web', number: 921, idleMinutes: 5 });
  assert.equal(rowMeta(ready, 'ready', at, at), '4/5 · web#921 · 5m');
  const noScore = report({ number: 77, idleMinutes: 60, reviewers: [] });
  assert.equal(rowMeta(noScore, 'ready', at, at), 'checks passed · web#77 · 1h');
  const conflicts = report({
    number: 318,
    state: 'conflicts',
    idleMinutes: 42,
    stack: { parent: null, position: null, size: 1, restack: { oldBase: 'feat/a', at: at.toISOString() } },
  });
  assert.equal(rowMeta(conflicts, 'needs', at, at), ' · parent merged · web#318 · 42m');
  assert.equal(rowMeta(report({ number: 45 }), 'reviewing', at, at), ' · web#45');
});

test('the glyphs are the marks of the terminal as icons, in their tones', () => {
  assert.deepEqual(stateGlyph(report({ state: 'checks failing' })), { icon: 'x', tone: 'red' });
  assert.deepEqual(stateGlyph(report({ state: 'changes requested' })), { icon: 'pencil', tone: 'red' });
  assert.deepEqual(stateGlyph(report({ state: 'quota' })), { icon: 'quota', tone: 'yellow' });
  assert.deepEqual(stateGlyph(report({ state: 'merged' })), { icon: 'merged', tone: 'magenta' });
  assert.deepEqual(reviewerGlyph('stale'), { icon: 'stale', tone: 'gray' });
  assert.deepEqual(reviewerGlyph('requested'), { icon: 'ring', tone: 'magenta' });
  assert.deepEqual(reviewerGlyph('unknown'), { icon: 'ring', tone: 'gray' });
});

test('the best score is the highest share among the reviewers', () => {
  const reviewer = report().reviewers[0]!;
  assert.deepEqual(
    bestScore([
      { ...reviewer, score: { score: 3, total: 5 } },
      { ...reviewer, score: { score: 9, total: 10 } },
      { ...reviewer, score: null },
    ]),
    { score: 9, total: 10 },
  );
  assert.equal(bestScore([]), undefined);
});
