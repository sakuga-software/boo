import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockersOf, mainAction, targetUrl } from './blockers';
import { report } from './report-fixture';

const reviewer = report().reviewers[0]!;

test('a pull request ready to merge, merged or closed has nothing that blocks it', () => {
  assert.deepEqual(blockersOf(report(), []), []);
  assert.deepEqual(blockersOf(report({ state: 'merged', stalled: true }), []), []);
});

test('the blockers come in order: checks, reviews, conflicts, agent, policy, threads, stack', () => {
  const parent = report({ number: 3, state: 'reviewing' });
  const blocked = report({
    state: 'checks failing',
    checks: {
      ...report().checks,
      failing: ['e2e (playwright)', 'kento'],
      reviewerErrors: [{ check: 'kento', error: 'rate limit' }],
    },
    reviewers: [{ ...reviewer, login: 'coderabbitai[bot]', mark: 'changes requested' }],
    agent: {
      kind: 'claude',
      session: null,
      sessionState: 'none',
      cloudSession: null,
      subAgent: { id: 'a', description: 'Fix the search filter', state: 'failed', error: 'rate limit' },
    },
    policy: [{ rule: 'minScore', note: 'score 3/5 from sakuga-review, the policy needs 4' }],
    threads: { open: 2, answered: 0 },
    stack: { parent: 'acme/web#3', position: 2, size: 2, restack: null },
  });
  assert.deepEqual(
    blockersOf(blocked, [parent, blocked]).map(({ what, why, action }) => [what, why, action?.label]),
    [
      ['e2e (playwright) fails', 'A check of the head commit is red', 'Re-run'],
      ['kento: the review bot failed', 'rate limit', 'Re-run'],
      ['coderabbitai requested changes', 'Answer the review, then ask again', 'Open'],
      ['No agent works on it', 'The sub-agent failed: rate limit', undefined],
      ['Score 3/5 from sakuga-review, the policy needs 4', 'A rule of the merge policy', 'Open'],
      ['2 bot threads with no answer', 'Answer them on GitHub', 'Open'],
      ['Stacked on #3', 'Merge it first: it is reviewing', undefined],
    ],
  );
});

test('conflicts after a merged parent say to rebase, and a stall with no failed agent shows', () => {
  const conflicts = report({
    state: 'conflicts',
    stalled: true,
    stack: { parent: null, position: null, size: 1, restack: { oldBase: 'feat/a', at: '' } },
  });
  assert.deepEqual(
    blockersOf(conflicts, []).map(({ what, why }) => [what, why]),
    [
      ['Conflicts with main', 'Its parent on feat/a merged: rebase it'],
      ['Stalled', 'It needs work, and no commit came for a while'],
    ],
  );
});

test('a read that failed, an owner to wait for, and a quota show as blockers', () => {
  const back = new Date(2026, 10, 10, 15, 40).toISOString();
  const waiting = report({
    state: 'quota',
    error: 'GitHub refused the read',
    needsOwner: { owner: 'mheaus', paths: ['a', 'b'], partial: false },
    notes: { merge: null, retries: [], coderabbit: { kind: 'wait', availableAt: back, delayGuessed: false } },
  });
  assert.deepEqual(
    blockersOf(waiting, []).map(({ what, why }) => [what, why]),
    [
      ['The relay could not read it', 'GitHub refused the read'],
      ['Needs mheaus', '2 files need their review'],
      ['A reviewer is out of quota', 'It reviews again at 15:40'],
    ],
  );
});

test('the main action names the failing check, or the place on GitHub', () => {
  const failing = blockersOf(report({ state: 'checks failing', checks: { ...report().checks, failing: ['e2e'] } }), []);
  assert.deepEqual(mainAction(failing), { label: 'Re-run e2e', icon: 'retry', target: 'checks' });
  const long = blockersOf(
    report({ state: 'checks failing', checks: { ...report().checks, failing: ['e2e (playwright)'] } }),
    [],
  );
  assert.equal(mainAction(long)?.label, 'Re-run e2e');
  const review = blockersOf(report({ reviewers: [{ ...reviewer, mark: 'changes requested' }] }), []);
  assert.equal(mainAction(review)?.label, 'Open on GitHub');
  assert.equal(mainAction([]), undefined);
  const url = 'https://github.com/acme/web/pull/12';
  assert.deepEqual(
    (['checks', 'files', 'pull'] as const).map((target) => targetUrl({ url }, target)),
    [`${url}/checks`, `${url}/files`, url],
  );
});
