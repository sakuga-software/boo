import assert from 'node:assert/strict';
import { test } from 'node:test';
import { report } from '../pulls/report-fixture';
import {
  agentShares,
  dateOf,
  dayTitle,
  isDayWork,
  leftForTomorrow,
  median,
  mergeMinutes,
  shiftDate,
  shortDuration,
  todaySummary,
  type MergedPull,
} from './day';

const pull = (patch: Partial<MergedPull> = {}): MergedPull => ({
  repo: 'acme/web',
  number: 1,
  title: 'One',
  author: 'alice',
  agent: 'claude',
  mergedAt: '2026-11-21T10:12:00Z',
  mergedBy: 'alice',
  reviews: 2,
  firstSeenAt: '2026-11-21T09:00:00Z',
  ...patch,
});

test('the dates of the phone, and the title of a day', () => {
  const now = new Date(2026, 10, 21, 18, 0);
  assert.equal(dateOf(now), '2026-11-21');
  assert.equal(shiftDate('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(dayTitle('2026-11-21', now), 'Today');
  assert.equal(dayTitle('2026-11-20', now), 'Yesterday');
  assert.match(dayTitle('2026-11-16', now), /Monday/);
});

test('the time to merge, its words, and the median', () => {
  assert.equal(mergeMinutes(pull()), 72);
  assert.equal(mergeMinutes(pull({ firstSeenAt: '2026-11-21T11:00:00Z' })), 0);
  assert.equal(shortDuration(48), '48 min');
  assert.equal(shortDuration(72), '1h12');
  assert.equal(shortDuration(245), '4h05');
  assert.equal(median([]), undefined);
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 20, 30, 41]), 25);
});

test('the share of each agent, the most first; no agent is the work of people', () => {
  assert.deepEqual(
    agentShares([pull(), pull({ agent: null }), pull({ agent: 'claude' }), pull({ agent: 'copilot' })]).map(
      ({ label, count, tone }) => `${label} ${count} ${tone}`,
    ),
    ['Claude Code 2 claude', 'Copilot 1 blue', 'People 1 gray'],
  );
});

test('what stays for tomorrow, and the figures of the Today card', () => {
  const now = new Date('2026-11-21T17:00:00Z');
  const reports = [
    report({ number: 1, state: 'checks failing' }),
    report({ number: 2, state: 'ready to merge' }),
    report({ number: 3, state: 'awaiting review', reviewers: [] }),
  ];
  assert.deepEqual(
    leftForTomorrow(reports, now).map(({ number }) => number),
    [1, 2],
  );
  const day = {
    date: '2026-11-21',
    merged: [pull(), pull({ firstSeenAt: '2026-11-21T10:00:00Z' })],
    previousMerged: 0,
    reviews: 3,
    redChecks: 1,
    historySince: null,
  };
  assert.ok(isDayWork(day));
  assert.equal(isDayWork({ merged: 'x' }), false);
  assert.deepEqual(todaySummary(reports, day, now), { merged: 2, needs: 1, ready: 1, median: '42 min' });
  assert.deepEqual(todaySummary([], undefined, now), { merged: undefined, needs: 0, ready: 0, median: undefined });
});
