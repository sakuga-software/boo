import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffReports, holdErrors, watchEvents, type WatchEvent, type WatchSources } from './events.js';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import type { PullRequestReport } from './report.js';
import { DEFAULT_SETTINGS } from './settings.js';

const AT = '2026-10-24T12:00:00.000Z';

const report = (number: number, patch: Partial<PullRequestReport> = {}): PullRequestReport => ({
  repo: 'acme/web',
  number,
  title: `feat: change ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  headSha: 'abc',
  base: 'main',
  isDraft: false,
  state: 'awaiting review',
  stalled: false,
  idleMinutes: null,
  mergedBy: null,
  mergedAt: null,
  error: null,
  checks: { passed: 2, failing: [], running: 0, skipped: 0, quota: 0 },
  reviewers: [],
  stack: { parent: null, position: 1, size: 1 },
  agent: { kind: null, session: null, subAgent: null, sessionState: 'none', cloudSession: null },
  notes: { merge: null, retries: [], coderabbit: null },
  policy: [],
  ...patch,
});
const byKey = (...reports: PullRequestReport[]) => new Map(reports.map((item) => [`acme/web#${item.number}`, item]));
const review = (patch: Partial<PullRequestReport['reviewers'][number]> = {}) => ({
  login: 'sakuga-review[bot]',
  mark: 'approved',
  onHead: true,
  verdict: 'approved',
  score: { score: 4, total: 5 },
  at: '2026-10-24T11:58:00.000Z',
  ...patch,
});

test('the first read gives one snapshot line for each pull request, with the keys of --json', () => {
  const [event] = diffReports(undefined, [report(1)], AT);
  assert.deepEqual(event, { at: AT, pr: 'acme/web#1', event: 'snapshot', ...report(1) });
});

test('a read with no change gives no event', () => {
  assert.deepEqual(diffReports(byKey(report(1)), [report(1)], AT), []);
});

test('a new state gives the failing checks, and each check that turns red or leaves red gives an event', () => {
  const before = report(1, { state: 'approved', checks: { ...report(1).checks, failing: ['lint'] } });
  const after = report(1, { state: 'checks failing', checks: { ...report(1).checks, failing: ['Migrations'] } });
  assert.deepEqual(diffReports(byKey(before), [after], AT), [
    { at: AT, pr: 'acme/web#1', event: 'state', from: 'approved', to: 'checks failing', failing: ['Migrations'] },
    { at: AT, pr: 'acme/web#1', event: 'check', check: 'Migrations', to: 'failing' },
    { at: AT, pr: 'acme/web#1', event: 'check', check: 'lint', to: 'not failing' },
  ]);
});

test('a new head commit and a new verdict give one event each', () => {
  const before = report(1, {
    reviewers: [review({ mark: 'stale', onHead: false, verdict: 'commented', score: null })],
  });
  const after = report(1, { headSha: 'def', reviewers: [review()] });
  assert.deepEqual(diffReports(byKey(before), [after], AT), [
    { at: AT, pr: 'acme/web#1', event: 'head', from: 'abc', to: 'def' },
    {
      at: AT,
      pr: 'acme/web#1',
      event: 'review',
      reviewer: 'sakuga-review[bot]',
      mark: 'approved',
      onHead: true,
      verdict: 'approved',
      score: { score: 4, total: 5 },
      reviewedAt: '2026-10-24T11:58:00.000Z',
    },
  ]);
});

test('a pull request enters the list, and others leave it merged or unlisted', () => {
  const events = diffReports(byKey(report(1), report(2)), [report(1, { state: 'merged' }), report(3)], AT);
  assert.deepEqual(
    events.map(({ pr, event, ...rest }) => [pr, event, 'reason' in rest ? rest.reason : undefined]),
    [
      ['acme/web#1', 'left', 'merged'],
      ['acme/web#3', 'entered', undefined],
      ['acme/web#2', 'left', 'unlisted'],
    ],
  );
});

test('only a merged pull request says who merged it', () => {
  const events = diffReports(
    byKey(report(1), report(2)),
    [report(1, { state: 'merged', mergedBy: null }), report(2, { state: 'closed' })],
    AT,
  );
  assert.deepEqual(
    events.map(({ at: _at, ...rest }) => rest),
    [
      { pr: 'acme/web#1', event: 'left', reason: 'merged', mergedBy: null, mergedAt: null },
      { pr: 'acme/web#2', event: 'left', reason: 'closed' },
    ],
  );
});

test('the first read gives a snapshot line also for a pull request that merged since the list', () => {
  assert.deepEqual(
    diffReports(undefined, [report(1, { state: 'merged' })], AT).map(({ event }) => event),
    ['snapshot'],
  );
});

test('the read after an error gives the changes since the last data that worked', () => {
  const kept = report(1, {
    state: 'error',
    error: 'HTTP 502',
    reviewers: [review({ verdict: 'commented', mark: 'commented' })],
  });
  const events = diffReports(byKey(kept), [report(1, { reviewers: [review()] })], AT);
  assert.deepEqual(
    events.map(({ event }) => event),
    ['state', 'review'],
  );
});

test('a read that failed gives only the change of state, not changes of data', () => {
  const failed = report(1, { state: 'error', error: 'HTTP 502', headSha: null, reviewers: [] });
  assert.deepEqual(diffReports(byKey(report(1, { reviewers: [review()] })), [failed], AT), [
    { at: AT, pr: 'acme/web#1', event: 'state', from: 'awaiting review', to: 'error', failing: [], error: 'HTTP 502' },
  ]);
});

const pr = (number: number): PullRequest => ({
  repo: 'acme/web',
  number,
  title: `feat: change ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
});
const snapshot = (patch: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  status: 'open',
  head: 'abc',
  branch: 'feat',
  fork: false,
  base: 'main',
  defaultBranch: 'main',
  author: 'mathieu',
  mergeState: 'clean',
  reviews: [],
  comments: [],
  checks: [],
  requested: [],
  ...patch,
});

test('the watch reads a pull request that left the search once more, to give the reason', async () => {
  const lists = [[pr(1), pr(2)], [pr(1)]];
  const fetched: number[] = [];
  const abort = new AbortController();
  const sources: WatchSources = {
    listPullRequests: async () => lists.shift() ?? [pr(1)],
    fetchPullRequest: async (target) => {
      fetched.push(target.number);
      return snapshot({
        branch: `b${target.number}`,
        ...(target.number === 2 &&
          lists.length === 0 && { status: 'merged', mergedBy: 'octocat', mergedAt: '2026-10-24T11:59:00Z' }),
      });
    },
    readOwners: async () => new Map(),
  };
  const events: WatchEvent[] = [];
  await watchEvents(
    sources,
    DEFAULT_SETTINGS,
    { intervalMs: 0, signal: abort.signal },
    async (event) => {
      events.push(event);
      if (event.event === 'left') abort.abort();
    },
    (error) => assert.fail(String(error)),
  );
  assert.deepEqual(
    events.map(({ pr: key, event }) => [key, event]),
    [
      ['acme/web#1', 'snapshot'],
      ['acme/web#2', 'snapshot'],
      ['acme/web#2', 'left'],
    ],
  );
  const { at: _at, ...left } = events.at(-1)!;
  assert.deepEqual(left, {
    pr: 'acme/web#2',
    event: 'left',
    reason: 'merged',
    mergedBy: 'octocat',
    mergedAt: '2026-10-24T11:59:00Z',
  });
  assert.deepEqual(fetched, [1, 2, 1, 2]);
});

test('the watch keeps the last data through two failed reads, and the error event gives the message', async () => {
  const reads = ['open', 'fail', 'fail', 'approved'];
  const abort = new AbortController();
  const approval = { user: { login: 'alice' }, commit_id: 'abc', submitted_at: AT, state: 'APPROVED' };
  const sources: WatchSources = {
    listPullRequests: async () => [pr(1)],
    fetchPullRequest: async () => {
      const read = reads.shift();
      if (read === 'fail') throw new Error('HTTP 502');
      return snapshot(read === 'approved' ? { reviews: [approval] } : {});
    },
    readOwners: async () => new Map(),
  };
  const events: WatchEvent[] = [];
  await watchEvents(
    sources,
    DEFAULT_SETTINGS,
    { intervalMs: 0, signal: abort.signal },
    async (event) => {
      events.push(event);
      if (event.event === 'review') abort.abort();
    },
    (error) => assert.fail(String(error)),
  );
  assert.deepEqual(
    events.map((event) => (event.event === 'state' ? `state ${event.from} → ${event.to}` : event.event)),
    ['snapshot', 'state awaiting review → error', 'state error → ready to merge', 'review'],
  );
  assert.equal(events[1]?.event === 'state' && events[1].error, 'HTTP 502');
});

test('one failed read between two good reads gives no event', () => {
  const failures = new Map<string, number>();
  const good = byKey(report(1));
  const failed = report(1, { state: 'error', error: 'HTTP 502' });
  assert.deepEqual(holdErrors(good, [failed], failures), [report(1)]);
  assert.deepEqual(holdErrors(good, [report(1)], failures), [report(1)]);
  assert.deepEqual(holdErrors(good, [failed], failures), [report(1)]);
  assert.deepEqual(holdErrors(good, [failed], failures), [failed]);
  assert.deepEqual(holdErrors(undefined, [failed], new Map()), [failed]);
});

test('an abort during a read stops the watch at once, not after the interval', async () => {
  const abort = new AbortController();
  const sources: WatchSources = {
    listPullRequests: async () => {
      abort.abort();
      return [];
    },
    fetchPullRequest: async () => snapshot(),
    readOwners: async () => new Map(),
  };
  const started = Date.now();
  await watchEvents(
    sources,
    DEFAULT_SETTINGS,
    { intervalMs: 60_000, signal: abort.signal },
    async () => {},
    () => {},
  );
  assert.ok(Date.now() - started < 1_000);
});

test('an abort during the read of the pull requests writes no event of that read', async () => {
  const abort = new AbortController();
  const sources: WatchSources = {
    listPullRequests: async () => [pr(1), pr(2)],
    fetchPullRequest: async () => {
      abort.abort();
      return snapshot();
    },
    readOwners: async () => new Map(),
  };
  const events: WatchEvent[] = [];
  await watchEvents(
    sources,
    DEFAULT_SETTINGS,
    { intervalMs: 60_000, signal: abort.signal },
    async (event) => void events.push(event),
    () => {},
  );
  assert.deepEqual(events, []);
});

test('a pull request that left the search and that GitHub did not give is read again, not called unlisted', async () => {
  const lists = [[pr(1)], [], [], []];
  const statuses: (PullRequestSnapshot['status'] | 'fail')[] = ['open', 'fail', 'merged'];
  const abort = new AbortController();
  const sources: WatchSources = {
    listPullRequests: async () => lists.shift() ?? [],
    fetchPullRequest: async () => {
      const status = statuses.shift();
      if (status === 'fail') throw new Error('HTTP 502');
      return snapshot({ status: status ?? 'merged' });
    },
    readOwners: async () => new Map(),
  };
  const events: WatchEvent[] = [];
  await watchEvents(
    sources,
    DEFAULT_SETTINGS,
    { intervalMs: 0, signal: abort.signal },
    async (event) => {
      events.push(event);
      if (event.event === 'left') abort.abort();
    },
    (error) => assert.fail(String(error)),
  );
  assert.deepEqual(
    events.map((event) => (event.event === 'left' ? `left ${event.reason}` : event.event)),
    ['snapshot', 'left merged'],
  );
});
