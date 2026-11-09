import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OVERALL_LABELS } from '@sakuga-software/boo-core/report';
import { OVERALL_MARKS } from '@sakuga-software/boo-core/theme';
import { report } from './report-fixture';
import { agentBadge, checksBadge, reportKey, reviewerChips, stackHint, stateView } from './view';

const checks = (patch: Partial<ReturnType<typeof report>['checks']>) => ({ ...report().checks, ...patch });

test('each label of the terminal gets the mark and the tone of the terminal', () => {
  for (const [overall, label] of Object.entries(OVERALL_LABELS) as [keyof typeof OVERALL_MARKS, string][]) {
    const view = stateView(report({ state: label }));
    assert.equal(view.label, label);
    assert.equal(view.mark, OVERALL_MARKS[overall].mark);
    assert.equal(view.tone, OVERALL_MARKS[overall].tone);
    assert.equal(view.spins, overall === 'reviewing');
  }
  assert.deepEqual(stateView(report({ state: 'checks failing' })), {
    mark: '✖',
    tone: 'red',
    label: 'checks failing',
    spins: false,
    stale: false,
  });
});

test('an error, a pull request that left the list, a draft and an unknown state get their marks', () => {
  assert.deepEqual(
    ['error', 'merged', 'closed', 'draft', 'open'].map((state) => {
      const { mark, tone } = stateView(report({ state }));
      return `${mark} ${tone}`;
    }),
    ['✖ red', '◆ magenta', '○ red', '◌ gray', '? gray'],
  );
});

test('a report of a read that GitHub refused is stale', () => {
  assert.equal(stateView(report({ stale: { at: '2026-11-09T10:00:00.000Z', until: null } })).stale, true);
});

test('the checks badge says what the terminal says, in the same order of importance', () => {
  assert.deepEqual(checksBadge(report().checks), { text: '✔ 3/3 checks', tone: 'green' });
  assert.deepEqual(checksBadge(checks({ passed: 2, failing: ['test'], running: 1 })), {
    text: '✖ 1/4 failing',
    tone: 'red',
  });
  // A red reviewer check is in `failing` too: it is not a failing check of the change.
  assert.deepEqual(
    checksBadge(checks({ passed: 2, failing: ['kento'], reviewerErrors: [{ check: 'kento', error: null }] })),
    { text: '⚠ 1/3 reviewer error', tone: 'yellow' },
  );
  assert.deepEqual(checksBadge(checks({ passed: 1, running: 2 })), { text: '◌ 2/3 running', tone: 'yellow' });
  assert.deepEqual(checksBadge(checks({ passed: 0, skipped: 2 })), { text: '⊘ 2 skipped', tone: 'gray', dim: true });
  assert.deepEqual(checksBadge(checks({ passed: 0, quota: 1 })), { text: '◷ 1 quota only', tone: 'gray', dim: true });
  assert.deepEqual(checksBadge(checks({ passed: 0 })), { text: 'no checks', tone: 'gray', dim: true });
});

test('the stack hint gives the parent and the place, the size of a stack, or a rebase', () => {
  const stack = (patch: Partial<ReturnType<typeof report>['stack']>) => ({ ...report().stack, ...patch });
  assert.equal(stackHint(stack({})), undefined);
  assert.equal(stackHint(stack({ parent: 'acme/web#12', position: 2, size: 3 })), 'on #12 · 2/3');
  assert.equal(stackHint(stack({ parent: 'acme/web#12', size: 2 })), 'on #12');
  assert.equal(stackHint(stack({ size: 3, position: 1 })), 'stack of 3');
  assert.equal(
    stackHint(stack({ parent: 'acme/web#12', restack: { oldBase: 'feature', at: '2026-11-09T10:00:00Z' } })),
    'parent merged · rebase',
  );
});

test('the agent badge names the agent of the pull request, and a cloud session', () => {
  const agent = (patch: Partial<ReturnType<typeof report>['agent']>) => ({ ...report().agent, ...patch });
  assert.equal(agentBadge(agent({})), undefined);
  assert.deepEqual(agentBadge(agent({ kind: 'claude' })), { mark: '✻', name: 'Claude', claude: true });
  assert.deepEqual(agentBadge(agent({ kind: 'claude', cloudSession: 'https://claude.ai/code/session_1' })), {
    mark: '✻',
    name: 'cloud',
    claude: true,
  });
  assert.deepEqual(agentBadge(agent({ kind: 'copilot' })), { mark: '◇', name: 'Copilot', claude: false });
});

test('a reviewer chip gives the mark of its status and the short name of the reviewer', () => {
  const reviewer = report().reviewers[0]!;
  assert.deepEqual(
    reviewerChips([
      reviewer,
      { ...reviewer, login: 'coderabbitai[bot]', mark: 'quota' },
      { ...reviewer, login: 'alice', mark: 'something new' },
    ]),
    [
      { mark: '✔', tone: 'green', name: 'kento-review' },
      { mark: '◷', tone: 'yellow', name: 'coderabbitai' },
      { mark: '?', tone: 'gray', name: 'alice' },
    ],
  );
  assert.equal(reportKey(report()), 'acme/web#12');
});
