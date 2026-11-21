import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, instantOf, localTime, nextWorkStart, parseQuiet, snoozePresets, workEnd, type Quiet } from './quiet.js';
import { parseSettings } from './settings.js';

const STATES = ['ready', 'merged'];
const PARIS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', timeZone: 'Europe/Paris' };
// Saturday 21 November 2026, 14:02 in Paris (UTC+1).
const SATURDAY = new Date('2026-11-21T13:02:00Z');

test('parseQuiet keeps the valid fields only', () => {
  assert.equal(parseQuiet(undefined, STATES), undefined);
  assert.equal(parseQuiet({ snoozeUntil: 'soon', through: ['x'] }, STATES), undefined);
  assert.deepEqual(
    parseQuiet(
      { snoozeUntil: '2026-11-21T17:00:00+00:00', through: ['ready', 'ready', 'nope'], workHours: PARIS },
      STATES,
    ),
    { snoozeUntil: '2026-11-21T17:00:00.000Z', through: ['ready'], workHours: PARIS },
  );
  for (const workHours of [
    { ...PARIS, start: '18:00', end: '09:00' },
    { ...PARIS, timeZone: 'Mars/Olympus' },
    { ...PARIS, days: [9] },
    { ...PARIS, start: '9:00' },
  ])
    assert.equal(parseQuiet({ workHours }, STATES), undefined);
  assert.deepEqual(parseSettings({ quiet: { workHours: PARIS } }).quiet, { workHours: PARIS });
});

test('localTime and instantOf agree, also across a change of daylight saving time', () => {
  assert.deepEqual(localTime(SATURDAY, 'Europe/Paris'), { date: '2026-11-21', day: 6, minutes: 14 * 60 + 2 });
  assert.equal(instantOf('2026-11-21', '18:00', 'Europe/Paris').toISOString(), '2026-11-21T17:00:00.000Z');
  assert.equal(instantOf('2026-07-01', '18:00', 'Europe/Paris').toISOString(), '2026-07-01T16:00:00.000Z');
  assert.equal(instantOf('2026-03-29', '09:00', 'Europe/Paris').toISOString(), '2026-03-29T07:00:00.000Z');
});

test('held: a snooze, or a time outside the work hours', () => {
  const thursday = new Date('2026-11-19T13:02:00Z');
  const quiet: Quiet = { workHours: PARIS };
  assert.equal(held(undefined, thursday), false);
  assert.equal(held(quiet, thursday), false);
  assert.equal(held(quiet, new Date('2026-11-19T17:00:00Z')), true);
  assert.equal(held(quiet, SATURDAY), true);
  assert.equal(held({ snoozeUntil: '2026-11-19T14:00:00Z' }, thursday), true);
  assert.equal(held({ snoozeUntil: '2026-11-19T13:00:00Z' }, thursday), false);
});

test('workEnd and nextWorkStart', () => {
  const thursday = new Date('2026-11-19T13:02:00Z');
  assert.equal(workEnd(PARIS, thursday)?.toISOString(), '2026-11-19T17:00:00.000Z');
  assert.equal(workEnd(PARIS, SATURDAY), undefined);
  assert.equal(nextWorkStart(PARIS, thursday)?.toISOString(), '2026-11-20T08:00:00.000Z');
  // From Friday evening, the next start is on Monday.
  assert.equal(nextWorkStart(PARIS, new Date('2026-11-20T18:00:00Z'))?.toISOString(), '2026-11-23T08:00:00.000Z');
  assert.equal(nextWorkStart({ ...PARIS, days: [] }, thursday), undefined);
});

test('the snooze presets depend on the time', () => {
  const thursday = new Date('2026-11-19T13:02:00Z');
  const labels = (quiet: Quiet | undefined, at: Date) =>
    snoozePresets(quiet, at, 'Europe/Paris').map(({ label, detail }) => `${label} (${detail})`);
  assert.deepEqual(labels({ workHours: PARIS }, thursday), [
    '1 hour (until 15:02)',
    '3 hours (until 17:02)',
    'Until 18:00 (end of work hours)',
    'Until tomorrow (Fri 09:00)',
  ]);
  // Friday at 17:30: the end of the work hours is less than one hour away, and the morning is Monday.
  assert.deepEqual(labels({ workHours: PARIS }, new Date('2026-11-20T16:30:00Z')), [
    '1 hour (until 18:30)',
    '3 hours (until 20:30)',
    'Until Monday (Mon 09:00)',
  ]);
  // No work hours: the morning is 09:00 tomorrow.
  assert.deepEqual(labels(undefined, thursday).at(-1), 'Until tomorrow (Fri 09:00)');
});
