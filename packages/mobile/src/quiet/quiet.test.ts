import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '@sakuga-software/boo-core/settings';
import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import {
  isQuietState,
  relayGet,
  shiftHour,
  snoozeEnd,
  untilWords,
  withReadyThrough,
  withSnooze,
  withWorkHours,
  workHoursWords,
} from './quiet';

const config = { org: 'acme', settings: { ...DEFAULT_SETTINGS } };
const HOURS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', timeZone: 'Europe/Paris' };

test('the snooze, the switch of "ready" and the work hours change only their key of quiet', () => {
  const until = new Date('2026-11-21T17:00:00Z');
  const snoozed = withSnooze(withWorkHours(config, HOURS), until);
  assert.deepEqual(snoozed.settings.quiet, { workHours: HOURS, snoozeUntil: '2026-11-21T17:00:00.000Z' });
  assert.equal(snoozed.org, 'acme');
  assert.deepEqual(withReadyThrough(snoozed, true).settings.quiet?.through, ['ready']);
  assert.deepEqual(withSnooze(snoozed, undefined).settings.quiet, { workHours: HOURS });
  // With nothing left, the settings have no quiet key.
  assert.equal('quiet' in withWorkHours(withSnooze(snoozed, undefined), undefined).settings, false);
  assert.equal('quiet' in withReadyThrough(config, false).settings, false);
});

test('snoozeEnd is the end of a snooze that runs now', () => {
  const now = new Date('2026-11-21T13:00:00Z');
  assert.equal(snoozeEnd(undefined, now), undefined);
  assert.equal(snoozeEnd(withSnooze(config, new Date('2026-11-21T12:00:00Z')), now), undefined);
  assert.equal(
    snoozeEnd(withSnooze(config, new Date('2026-11-21T17:00:00Z')), now)?.toISOString(),
    '2026-11-21T17:00:00.000Z',
  );
});

test('the words of the work hours and of the end of a snooze', () => {
  assert.equal(workHoursWords(undefined), 'Off · every push at once');
  assert.equal(workHoursWords(HOURS), 'Mon–Fri · 09:00 – 18:00');
  assert.equal(workHoursWords({ ...HOURS, days: [1, 3] }), 'Mon, Wed · 09:00 – 18:00');
  assert.equal(workHoursWords({ ...HOURS, days: [0, 1, 2, 3, 4, 5, 6] }), 'Every day · 09:00 – 18:00');
  const now = new Date(2026, 10, 21, 14, 2);
  assert.equal(untilWords(new Date(2026, 10, 21, 18, 0), now), '18:00');
  assert.equal(untilWords(new Date(2026, 10, 23, 9, 0), now), 'Mon 09:00');
});

test('shiftHour moves by steps and stays in the day', () => {
  assert.equal(shiftHour('09:00', 30), '09:30');
  assert.equal(shiftHour('09:00', -30), '08:30');
  assert.equal(shiftHour('00:00', -30), '00:00');
  assert.equal(shiftHour('23:30', 30), '23:30');
});

test('relayGet: a 401 is an expired session, a bad body or a refusal is a failure', async () => {
  const connection = { url: 'https://relay.test', session: 'sess', login: 'alice' } as unknown as RelayConnection;
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  assert.deepEqual(await relayGet(connection, answer(200, { holding: true, held: 2 }), '/quiet', isQuietState), {
    status: 'ok',
    value: { holding: true, held: 2 },
  });
  assert.deepEqual(await relayGet(connection, answer(401, {}), '/quiet', isQuietState), { status: 'expired' });
  assert.equal((await relayGet(connection, answer(404, {}), '/quiet', isQuietState)).status, 'failed');
  assert.equal((await relayGet(connection, answer(200, { held: 'x' }), '/quiet', isQuietState)).status, 'failed');
  const down = (async () => {
    throw new TypeError('offline');
  }) as typeof fetch;
  assert.equal((await relayGet(connection, down, '/quiet', isQuietState)).status, 'failed');
});
