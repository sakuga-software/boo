import assert from 'node:assert/strict';
import { test } from 'node:test';
import { report } from '../pulls/report-fixture';
import {
  dayLabel,
  eventsBetween,
  groupByDay,
  isUnread,
  loadLog,
  MAX_EVENTS,
  parseLog,
  unreadCount,
  withEvents,
  type ActivityEvent,
} from './events';

const at = new Date('2026-11-10T14:58:00.000Z');
const ids = (key: string, index: number) => `${key}:e${index}`;
const reviewer = report().reviewers[0]!;

test('a change of state gives one event, with the words and the glyph of the new state', () => {
  const before = [
    report({ number: 1, state: 'reviewing' }),
    report({ number: 2, state: 'reviewing' }),
    report({ number: 3, state: 'reviewing', checks: { ...report().checks, failing: ['lint'] } }),
    report({ number: 4, state: 'reviewing', base: 'main' }),
    report({ number: 5, state: 'ready to merge' }),
  ];
  const after = [
    report({ number: 1, state: 'ready to merge' }),
    report({
      number: 2,
      state: 'changes requested',
      reviewers: [{ ...reviewer, login: 'coderabbitai[bot]', mark: 'changes requested', at: at.toISOString() }],
    }),
    report({ number: 3, state: 'checks failing', checks: { ...report().checks, failing: ['lint', 'e2e'] } }),
    report({ number: 4, state: 'conflicts', base: 'main' }),
    report({ number: 5, state: 'merged', mergedBy: 'mheaus' }),
  ];
  const events = eventsBetween(before, after, at, ids);
  assert.deepEqual(
    events.map(({ what, icon, tone, actor, canMerge }) => ({ what, icon, tone, actor, canMerge })),
    [
      { what: 'Ready to merge', icon: 'check', tone: 'green', actor: undefined, canMerge: true },
      {
        what: 'coderabbitai requested changes',
        icon: 'pencil',
        tone: 'red',
        actor: 'coderabbitai[bot]',
        canMerge: undefined,
      },
      { what: 'e2e failed', icon: 'x', tone: 'red', actor: undefined, canMerge: undefined },
      { what: 'Conflicts with main', icon: 'warn', tone: 'red', actor: undefined, canMerge: undefined },
      { what: 'Merged by mheaus', icon: 'merged', tone: 'magenta', actor: 'mheaus', canMerge: undefined },
    ],
  );
  assert.deepEqual(events[0]!, {
    icon: 'check',
    tone: 'green',
    what: 'Ready to merge',
    canMerge: true,
    id: 'acme/web#1:e0',
    key: 'acme/web#1',
    name: 'web#1',
    title: 'Show the list',
    at: at.toISOString(),
  });
});

test('a stall and a new comment of a reviewer give events, the same state gives none', () => {
  const before = [
    report({ number: 1, state: 'checks failing' }),
    report({ number: 2, state: 'reviewed', reviewers: [] }),
  ];
  const comment = {
    ...reviewer,
    login: 'greptile-apps[bot]',
    mark: 'commented',
    at: at.toISOString(),
    score: { score: 4, total: 5 },
  };
  const after = [
    report({ number: 1, state: 'checks failing', stalled: true }),
    report({ number: 2, state: 'reviewed', reviewers: [comment] }),
  ];
  assert.deepEqual(
    eventsBetween(before, after, at, ids).map(({ what }) => what),
    ['Stalled, no new commit', 'greptile commented · 4/5'],
  );
  assert.deepEqual(eventsBetween(after, after, at, ids), []);
});

test('a pull request that only one list has gives no event: the first list of a session stays quiet', () => {
  assert.deepEqual(eventsBetween([], [report({ state: 'ready to merge' })], at, ids), []);
});

test('the log keeps the newest events on top, up to its limit, and counts the ones after the last read', () => {
  const event = (id: string, when: string): ActivityEvent => ({
    id,
    key: 'acme/web#1',
    icon: 'check',
    tone: 'green',
    what: 'Ready to merge',
    name: 'web#1',
    title: '',
    at: when,
  });
  const log = { events: [event('old', '2026-11-10T10:00:00.000Z')], readAt: '2026-11-10T12:00:00.000Z' };
  const next = withEvents(log, [event('new', '2026-11-10T14:00:00.000Z')]);
  assert.deepEqual(
    next.events.map(({ id }) => id),
    ['new', 'old'],
  );
  assert.equal(unreadCount(next), 1);
  assert.equal(isUnread(next, next.events[1]!), false);
  assert.equal(withEvents(log, []), log);
  const full = withEvents(
    { events: [], readAt: '' },
    Array.from({ length: MAX_EVENTS + 5 }, (_, i) => event(`${i}`, '')),
  );
  assert.equal(full.events.length, MAX_EVENTS);
});

test('the events group by day: the last hour is Now, then Today and Yesterday', () => {
  const now = new Date(2026, 10, 10, 15, 0);
  assert.equal(dayLabel(now, new Date(2026, 10, 10, 14, 30)), 'Now');
  assert.equal(dayLabel(now, new Date(2026, 10, 10, 9, 0)), 'Today');
  assert.equal(dayLabel(now, new Date(2026, 10, 9, 22, 0)), 'Yesterday');
  const at = (hour: number, day = 10, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
  const events = [at(14, 10, 30), at(9), at(8), at(22, 9)].map((when, index): ActivityEvent => ({
    id: `${index}`,
    key: '',
    icon: 'dot',
    tone: 'cyan',
    what: '',
    name: '',
    title: '',
    at: when,
  }));
  assert.deepEqual(
    groupByDay(events, now).map(({ label, events }) => [label, events.length]),
    [
      ['Now', 1],
      ['Today', 2],
      ['Yesterday', 1],
    ],
  );
});

test('a log file that is missing or broken gives an empty log, read from now', () => {
  const now = new Date('2026-11-10T15:00:00.000Z');
  assert.deepEqual(parseLog(undefined, now), { events: [], readAt: now.toISOString() });
  assert.deepEqual(parseLog('{', now), { events: [], readAt: now.toISOString() });
  assert.deepEqual(parseLog('{"events":3}', now), { events: [], readAt: now.toISOString() });
  assert.deepEqual(parseLog('{"events":[],"readAt":"x"}', now), { events: [], readAt: 'x' });
});

test('a log that the phone cannot read is not written: a later read can still give it', async () => {
  const now = new Date('2026-11-10T15:00:00.000Z');
  const failed = await loadLog(() => Promise.reject(new Error('busy')), now);
  assert.deepEqual(failed, { log: { events: [], readAt: now.toISOString() }, writable: false });
  const missing = await loadLog(() => Promise.resolve(undefined), now);
  assert.equal(missing.writable, true);
  const read = await loadLog(() => Promise.resolve('{"events":[],"readAt":"x"}'), now);
  assert.deepEqual(read, { log: { events: [], readAt: 'x' }, writable: true });
});

test('two events of one list get two ids, each with the key of its pull request', () => {
  const before = [report({ number: 1, state: 'reviewing' }), report({ number: 2, state: 'reviewing' })];
  const after = [report({ number: 1, state: 'ready to merge' }), report({ number: 2, state: 'conflicts' })];
  assert.deepEqual(
    eventsBetween(before, after, at, ids).map(({ id }) => id),
    ['acme/web#1:e0', 'acme/web#2:e1'],
  );
});
