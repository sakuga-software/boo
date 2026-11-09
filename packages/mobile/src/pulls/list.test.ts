import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterRead, FIRST_READ, listView, startRead, type PullsState } from './list';
import { report } from './report-fixture';

const at = '2026-11-09T11:00:00.000Z';
const state = { cursor: 'abcd-1', at, reports: [report()] };

test('the first read shows a spinner, then the rows', () => {
  assert.deepEqual(listView(FIRST_READ), { kind: 'first read' });
  const read = afterRead(FIRST_READ, { status: 'read', state });
  assert.deepEqual(read, { state, loading: false, refreshing: false });
  assert.deepEqual(listView(read), { kind: 'rows', at: new Date(at), reports: state.reports });
});

test('a list with no pull request is empty', () => {
  const read = afterRead(FIRST_READ, { status: 'read', state: { ...state, reports: [] } });
  assert.equal(listView(read).kind, 'empty');
});

test('a first read that fails shows the error, and a new read shows the spinner again', () => {
  const failed = afterRead(FIRST_READ, { status: 'failed', message: 'The relay cannot be reached.' });
  assert.deepEqual(listView(failed), { kind: 'failed', message: 'The relay cannot be reached.' });
  assert.deepEqual(listView(startRead(failed, false)), { kind: 'first read' });
});

test('a read that fails keeps the older list, stale, until a read works', () => {
  const read = afterRead(FIRST_READ, { status: 'read', state });
  const failed = afterRead(startRead(read, true), { status: 'failed', message: 'The relay did not answer in 15 s.' });
  assert.deepEqual(listView(failed), {
    kind: 'rows',
    at: new Date(at),
    reports: state.reports,
    stale: 'The relay did not answer in 15 s.',
  });
  const again = afterRead(startRead(failed, false), { status: 'read', state });
  assert.equal(again.error, undefined);
  assert.equal('stale' in listView(again), false);
});

test('only a pull shows the spinner of the pull, until the read ends', () => {
  const read: PullsState = afterRead(FIRST_READ, { status: 'read', state });
  assert.equal(startRead(read, false).refreshing, false);
  const pulled = startRead(read, true);
  assert.deepEqual(pulled, { ...read, loading: true, refreshing: true });
  // A read on return to the app during the pull keeps its spinner.
  assert.equal(startRead(pulled, false).refreshing, true);
  assert.equal(afterRead(pulled, { status: 'read', state }).refreshing, false);
});
