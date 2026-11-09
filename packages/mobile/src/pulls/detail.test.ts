import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coderabbitNote, detailSections, scoreTone, type Section } from './detail';
import { report } from './report-fixture';

const at = new Date(2026, 10, 9, 12, 0);
const now = new Date(2026, 10, 9, 12, 10);
const iso = (minutesBefore: number) => new Date(now.getTime() - minutesBefore * 60_000).toISOString();
/** The sections as text: one string per line. */
const text = (sections: Section[]) =>
  Object.fromEntries(
    sections.map(({ label, lines }) => [label, lines.map((line) => line.map(({ text }) => text).join(''))]),
  );

test('a green pull request shows its change, its reviewers and its checks', () => {
  const item = report({ reviewers: [{ ...report().reviewers[0]!, at: iso(20) }] });
  assert.deepEqual(text(detailSections(item, [item], at, now)), {
    changes: ['+120 −8 · 4 files · last commit 15 min ago'],
    reviewers: ['1/1 on head · last kento-review 20 min ago', '✔ kento-review  approved · confidence 4/5 · 20 min ago'],
    checks: ['✔ 3 passed'],
  });
});

test('the tones follow the terminal: green and red counts, the tone of a score', () => {
  const [changes] = detailSections(report(), [], at, now);
  assert.deepEqual(
    changes!.lines[0]!.map(({ tone }) => tone),
    ['green', undefined, 'red', undefined],
  );
  assert.deepEqual(
    [scoreTone({ score: 4, total: 5 }), scoreTone({ score: 3, total: 5 }), scoreTone({ score: 2, total: 5 })],
    ['green', 'yellow', 'red'],
  );
});

test('failing checks give their names, and a red reviewer check says that the bot failed', () => {
  const item = report({
    checks: {
      passed: 2,
      failing: ['test (ubuntu)', 'kento'],
      running: 1,
      skipped: 1,
      quota: 1,
      reviewerErrors: [{ check: 'kento', error: 'API key expired' }],
    },
  });
  assert.deepEqual(text(detailSections(item, [item], at, now)).checks, [
    '✔ 2 passed   ✖ 1 failing   ⚠ 1 reviewer error   ◌ 1 running   ⊘ 1 skipped   ◷ 1 quota only',
    '✖ test (ubuntu)',
    '⚠ kento · the review bot failed, not the change: API key expired',
  ]);
  const none = report({ checks: { ...report().checks, passed: 0 } });
  assert.deepEqual(text(detailSections(none, [], at, now)).checks, ['no checks']);
});

test('each reviewer status reads as in the terminal', () => {
  const base = { ...report().reviewers[0]!, score: null, at: null, onHead: false };
  const item = report({
    reviewers: [
      { ...base, login: 'coderabbitai[bot]', mark: 'quota' },
      { ...base, login: 'greptile-apps[bot]', mark: 'stale', verdict: 'changes requested' },
      { ...base, login: 'alice', mark: 'stale', verdict: 'commented' },
      { ...base, login: 'copilot-pull-request-reviewer[bot]', mark: 'requested', verdict: null },
      { ...base, login: 'bob', mark: 'brand new' },
    ],
  });
  assert.deepEqual(text(detailSections(item, [item], at, now)).reviewers, [
    '0/5 on head · no review yet',
    '◷ coderabbitai  out of quota',
    '◌ greptile  an older commit only, changes requested still stands',
    '◌ alice  an older commit only',
    '○ copilot  requested',
    '? bob  brand new',
  ]);
  assert.deepEqual(text(detailSections(report({ reviewers: [] }), [], at, now)).reviewers, ['no reviewer yet']);
});

test('the agent of the pull request, with its cloud session', () => {
  const item = report({
    agent: { ...report().agent, kind: 'claude', cloudSession: 'https://claude.ai/code/session_1' },
  });
  assert.deepEqual(text(detailSections(item, [], at, now)).agent, [
    '✻ Claude Code · cloud session',
    'https://claude.ai/code/session_1',
  ]);
  const copilot = report({ agent: { ...report().agent, kind: 'copilot' } });
  assert.deepEqual(text(detailSections(copilot, [], at, now)).agent, ['◇ Copilot']);
});

test('the notes give the stale read, the policy, the stall, the stack, the merge, the retries and CodeRabbit', () => {
  const parent = report({ number: 12, state: 'checks failing' });
  const item = report({
    number: 14,
    base: 'feature',
    stale: { at: iso(30), until: iso(-20) },
    policy: [{ rule: 'minScore', note: 'no score from kento on head' }],
    stalled: true,
    idleMinutes: 50,
    stack: { parent: 'acme/web#12', position: 2, size: 2, restack: { oldBase: 'feature-old', at: iso(5) } },
    notes: {
      merge: 'behind the base branch',
      retries: [{ bot: 'Greptile', at: iso(-5) }],
      coderabbit: { kind: 'pending', requestedAt: iso(3) },
    },
  });
  const time = (minutesBefore: number) => {
    const date = new Date(now.getTime() - minutesBefore * 60_000);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };
  assert.deepEqual(text(detailSections(item, [parent, item], at, now)).notes, [
    `stale: the state of ${time(30)}. GitHub refuses the queries (rate limit), GitHub answers again at ${time(-20)}`,
    'merge policy: no score from kento on head',
    'stalled: it needs work, and the last commit is 1 h ago',
    'stacked on web#12 (checks failing): merge it first',
    'rebase on feature: its parent on feature-old merged, and its commits are still here',
    'behind the base branch',
    `Greptile retry at ${time(-5)}`,
    `CodeRabbit asked at ${time(3)}, no reply yet`,
  ]);
  // A parent that left the list has no state to show.
  const alone = report({ number: 14, stack: { parent: 'acme/web#12', position: 2, size: 2, restack: null } });
  assert.deepEqual(text(detailSections(alone, [alone], at, now)).notes, ['stacked on web#12: merge it first']);
});

test('the CodeRabbit notes read as in the terminal', () => {
  assert.equal(
    coderabbitNote({ kind: 'wait', availableAt: iso(-75), delayGuessed: true }, now)?.replace(/\d\d:\d\d/, 'HH:MM'),
    'CodeRabbit quota back in 1 h 15 min (at HH:MM) · unreadable delay, 1 h assumed',
  );
  assert.equal(
    coderabbitNote({ kind: 'wait', availableAt: iso(1), delayGuessed: false }, now)?.replace(/\d\d:\d\d/, 'HH:MM'),
    'CodeRabbit quota back now (at HH:MM)',
  );
  assert.equal(coderabbitNote({ kind: 'trigger', availableAt: iso(12) }, now), 'CodeRabbit quota back for 12 min');
  assert.equal(
    coderabbitNote({ kind: 'skipped', reason: 'Draft PR not reviewed' }, now),
    'CodeRabbit skipped the review: Draft PR not reviewed',
  );
  assert.equal(coderabbitNote({ kind: 'paused' }, now), 'CodeRabbit reviews are paused');
  assert.equal(coderabbitNote({ kind: 'idle' }, now), 'CodeRabbit: the last commit has no review');
  assert.equal(coderabbitNote(null, now), undefined);
});

test('a merged pull request, an error, a draft and a relay with no size of the change', () => {
  const merged = report({ state: 'merged', mergedBy: 'alice', mergedAt: iso(120) });
  assert.deepEqual(text(detailSections(merged, [], at, now)), {
    changes: ['+120 −8 · 4 files · last commit 15 min ago'],
    merged: ['by alice · 2 h ago'],
  });
  const unknown = report({ state: 'merged', mergedBy: null, mergedAt: iso(1), changes: null, idleMinutes: null });
  assert.deepEqual(text(detailSections(unknown, [], at, now)), { merged: ['by an unknown account · 1 min ago'] });
  const failed = report({ state: 'error', error: 'Not read yet', changes: null });
  assert.deepEqual(text(detailSections(failed, [], at, now)), {
    changes: ['last commit 15 min ago'],
    notes: ['Not read yet'],
  });
  // A relay older than the key `changes` does not give it.
  const { changes: _changes, ...older } = report({ state: 'draft', draftState: 'approved' });
  assert.deepEqual(text(detailSections(older as ReturnType<typeof report>, [], at, now)).notes, [
    'draft: approved once ready for review',
  ]);
});
