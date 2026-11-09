import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PullRequestSnapshot } from '@sakuga-software/boo-core/github';
import { DEFAULT_SETTINGS } from '@sakuga-software/boo-core/settings';
import { LOG_SIZE, readableReports, Reports, type UserState } from './reports.js';
import { StateStore } from './state-store.js';

const MINUTE = 60_000;
const start = Date.parse('2026-11-09T12:00:00Z');
const pr = (number: number, repo = 'acme/web') => ({
  repo,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
});
const snapshot = (patch: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  status: 'open',
  head: 'a1',
  branch: 'feature',
  fork: false,
  base: 'main',
  defaultBranch: 'main',
  author: 'alice',
  mergeState: 'clean',
  reviews: [],
  comments: [],
  checks: [{ name: 'ci', state: 'failure' }],
  requested: [],
  headAt: new Date(start).toISOString(),
  ...patch,
});

function setup() {
  let clock = start;
  const store = new StateStore(':memory:');
  store.setConfig('alice', { org: 'acme', settings: { ...DEFAULT_SETTINGS, stalledAfterMinutes: 30 } }, clock);
  store.savePull(pr(1), { snapshot: snapshot() }, clock);
  store.setFollows('alice', [pr(1)], clock);
  const reports = new Reports(store, () => clock);
  const changes: { login: string; before?: UserState; after: UserState }[] = [];
  reports.onChange((login, before, after) => changes.push({ login, ...(before && { before }), after }));
  return { store, reports, changes, advance: (ms: number) => void (clock += ms) };
}

test('the cursor stays while only the idle minutes change', () => {
  const { reports, changes, advance } = setup();
  const first = reports.get('Alice');
  assert.equal(first.reports[0]?.state, 'checks failing');
  assert.equal(first.reports[0]?.idleMinutes, 0);
  advance(5 * MINUTE);
  const second = reports.refresh('alice');
  assert.equal(second.reports[0]?.idleMinutes, 5);
  assert.equal(second.cursor, first.cursor);
  assert.equal(changes.length, 1, 'only the first computation');
});

test('the timer finds a pull request that stalls, with no webhook', () => {
  const { reports, changes, advance } = setup();
  const first = reports.get('alice');
  assert.equal(first.reports[0]?.stalled, false);
  advance(31 * MINUTE);
  reports.refreshAll();
  const after = reports.get('alice');
  assert.equal(after.reports[0]?.stalled, true);
  assert.notEqual(after.cursor, first.cursor);
  assert.equal(changes.at(-1)?.before?.cursor, first.cursor);
});

test('a read of a pull request moves the cursor of each user that follows it', () => {
  const { store, reports, advance } = setup();
  store.setConfig('bob', { org: 'acme', settings: DEFAULT_SETTINGS }, start);
  store.setFollows('bob', [pr(1)], start);
  const alice = reports.get('alice').cursor;
  const bob = reports.get('bob').cursor;
  advance(MINUTE);
  store.savePull(pr(1), { snapshot: snapshot({ checks: [{ name: 'ci', state: 'success' }] }) }, start + MINUTE);
  reports.refreshFollowers(pr(1));
  assert.notEqual(reports.get('alice').cursor, alice);
  assert.notEqual(reports.get('bob').cursor, bob);
  assert.equal(reports.get('bob').reports[0]?.state, 'awaiting review');
});

test('a user with no settings has no reports, and the reports keep only the readable repositories', () => {
  const { store, reports } = setup();
  assert.deepEqual(reports.get('nobody').reports, []);
  store.savePull(pr(2, 'acme/secret'), { snapshot: snapshot() }, start);
  store.setFollows('alice', [pr(1), pr(2, 'acme/secret')], start);
  const all = reports.refresh('alice');
  assert.equal(all.reports.length, 2);
  assert.deepEqual(
    readableReports(all, new Set(['acme/web'])).reports.map((report) => report.number),
    [1],
  );
});

test('a listener that stops gets no more changes', () => {
  const { store, reports, advance } = setup();
  const seen: string[] = [];
  const stop = reports.onChange((login) => seen.push(login));
  reports.get('alice');
  stop();
  advance(MINUTE);
  store.savePull(pr(1), { snapshot: snapshot({ head: 'a2' }) }, start + MINUTE);
  reports.refresh('alice');
  assert.deepEqual(seen, ['alice']);
});

test('a pull request that stalls gives a snapshot event, and a stream resumes from any kept cursor', () => {
  const { reports, advance } = setup();
  const first = reports.get('alice');
  advance(31 * MINUTE);
  const stalled = reports.refresh('alice');
  const missed = reports.since('alice', first.cursor);
  assert.ok(Array.isArray(missed));
  assert.deepEqual(
    missed.map(({ cursor, event }) => [cursor, event.event, event.pr]),
    [[stalled.cursor, 'snapshot', 'acme/web#1']],
  );
  assert.deepEqual(reports.since('alice', stalled.cursor), []);
  assert.equal(reports.since('alice', '00000000-0'), 'reset');
  assert.equal(reports.since('alice', `${stalled.cursor.split('-')[0]}-99`), 'reset');
  assert.equal(reports.since('bob', first.cursor), 'reset');
});

test('a cursor older than the kept changes gets a reset', () => {
  const { store, reports, advance } = setup();
  const first = reports.get('alice');
  for (let index = 0; index <= LOG_SIZE; index++) {
    advance(MINUTE);
    store.savePull(pr(1), { snapshot: snapshot({ head: `h${index}` }) }, start);
    reports.refresh('alice');
  }
  assert.equal(reports.since('alice', first.cursor), 'reset');
  const last = reports.get('alice').cursor;
  const kept = `${last.split('-')[0]}-${Number(last.split('-')[1]) - 3}`;
  const missed = reports.since('alice', kept);
  assert.ok(Array.isArray(missed));
  assert.deepEqual(
    missed.map(({ event }) => event.event),
    ['head', 'head', 'head'],
  );
});

test('a new comment of a person gives a comment event, and a merge gives one left event', () => {
  const { store, reports, changes, advance } = setup();
  reports.get('alice');
  advance(MINUTE);
  const comment = {
    id: 9,
    user: { login: 'bob' },
    body: 'Can you rename this?',
    created_at: new Date(start + MINUTE).toISOString(),
    updated_at: new Date(start + MINUTE).toISOString(),
  };
  store.savePull(pr(1), { snapshot: snapshot({ comments: [comment] }) }, start + MINUTE);
  reports.refresh('alice');
  const talk = reports.since('alice', reports.get('alice').cursor.replace(/\d+$/, '0'));
  assert.ok(Array.isArray(talk));
  assert.deepEqual(
    talk.map(({ event }) => event.event),
    ['comment'],
  );
  advance(MINUTE);
  store.savePull(pr(1), { snapshot: snapshot({ status: 'merged', mergedAt: new Date(start).toISOString() }) }, start);
  reports.refresh('alice');
  advance(MINUTE);
  reports.refresh('alice');
  const left = changes.flatMap(({ after, before }) => (before ? [after.cursor] : []));
  const events = reports.since('alice', reports.get('alice').cursor.replace(/\d+$/, '1'));
  assert.ok(Array.isArray(events));
  assert.deepEqual(
    events.map(({ event }) => event.event),
    ['left'],
  );
  assert.equal(left.length, 2, 'the comment, then the merge: the second computation of the merge moves nothing');
});

test('a pull request that a user starts to follow later gives no event for its old comments, and one for a new comment', () => {
  const { store, reports, advance } = setup();
  reports.get('alice');
  const comment = (id: number, minute: number) => ({
    id,
    user: { login: 'bob' },
    body: `comment ${id}`,
    created_at: new Date(start + minute * MINUTE).toISOString(),
    updated_at: new Date(start + minute * MINUTE).toISOString(),
  });
  advance(MINUTE);
  store.savePull(pr(2), { snapshot: snapshot({ comments: [comment(1, 0)] }) }, start + MINUTE);
  store.setFollows('alice', [pr(1), pr(2)], start + MINUTE);
  const entered = reports.refresh('alice');
  advance(MINUTE);
  store.savePull(pr(2), { snapshot: snapshot({ comments: [comment(1, 0), comment(2, 2)] }) }, start + 2 * MINUTE);
  reports.refresh('alice');
  const events = reports.since('alice', entered.cursor.replace(/\d+$/, '0'));
  assert.ok(Array.isArray(events));
  assert.deepEqual(
    events.map(({ event }) => [event.event, event.pr, 'body' in event ? event.body : null]),
    [
      ['entered', 'acme/web#2', null],
      ['comment', 'acme/web#2', 'comment 2'],
    ],
  );
});

test('a user whose reports fail does not stop the others', () => {
  const { store, reports } = setup();
  store.setConfig('bob', { org: 'acme', settings: DEFAULT_SETTINGS }, start);
  store.setFollows('bob', [pr(1)], start);
  const refresh = reports.refresh.bind(reports);
  const done: string[] = [];
  reports.refresh = (login) => {
    if (login === 'alice') throw new Error('a broken config');
    done.push(login);
    return refresh(login);
  };
  const logged: string[] = [];
  reports.refreshAll((error) => logged.push(String(error)));
  assert.deepEqual(done, ['bob']);
  assert.deepEqual(logged, ['Error: a broken config']);
});
