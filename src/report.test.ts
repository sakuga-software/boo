import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import { buildReport, stallOf, type ReportInput } from './report.js';
import type { LocalSession, Owner } from './sessions.js';
import { DEFAULT_SETTINGS } from './settings.js';

const now = new Date('2026-10-24T12:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const pr = (number: number, repo = 'acme/web'): PullRequest => ({
  repo,
  number,
  title: `feat: change ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
});

const snapshot = (patch: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  status: 'open',
  head: 'abc123',
  branch: 'feat-a',
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

const session: LocalSession = {
  pid: 1,
  sessionId: 's1',
  name: 'web-2',
  status: 'busy',
  cwd: '/tmp/web',
  socket: '/tmp/web.sock',
};

const report = (inputs: ReportInput[], owners = new Map<string, Owner>()) =>
  buildReport(inputs, owners, DEFAULT_SETTINGS, now);

test('the output keeps the same keys, in the same order', () => {
  const [first] = report([{ pr: pr(1), snapshot: snapshot() }]);
  assert.deepEqual(Object.keys(first!), [
    'repo',
    'number',
    'title',
    'url',
    'headSha',
    'base',
    'isDraft',
    'state',
    'stalled',
    'idleMinutes',
    'error',
    'checks',
    'reviewers',
    'stack',
    'agent',
    'notes',
    'policy',
  ]);
  assert.deepEqual(Object.keys(first!.checks), ['passed', 'failing', 'running', 'skipped', 'quota']);
  assert.deepEqual(Object.keys(first!.stack), ['parent', 'position', 'size']);
  assert.deepEqual(Object.keys(first!.agent), ['kind', 'session', 'sessionState', 'cloudSession']);
  assert.deepEqual(Object.keys(first!.notes), ['merge', 'retries', 'coderabbit']);
});

test('an approved pull request with green checks is ready to merge, as in the human output', () => {
  const [first] = report([
    {
      pr: pr(1),
      snapshot: snapshot({
        reviews: [{ user: { login: 'alice' }, commit_id: 'abc123', submitted_at: ago(5), state: 'APPROVED' }],
        checks: [
          { name: 'Test', state: 'success' },
          { name: 'Lint', state: 'pending' },
        ],
      }),
    },
  ]);
  assert.equal(first!.state, 'approved');
  assert.deepEqual(first!.checks, { passed: 1, failing: [], running: 1, skipped: 0, quota: 0 });
  assert.deepEqual(first!.reviewers, [
    { login: 'alice', mark: 'approved', onHead: true, verdict: 'approved', score: null, at: ago(5) },
  ]);
});

test('a failing check gives its name, and a blocked merge gives the rule', () => {
  const [first] = report([
    {
      pr: pr(1),
      snapshot: snapshot({ mergeState: 'blocked', checks: [{ name: 'Migrations', state: 'failure' }] }),
    },
  ]);
  assert.equal(first!.state, 'checks failing');
  assert.deepEqual(first!.checks.failing, ['Migrations']);
  assert.equal(first!.notes.merge, 'blocked by the branch protection rules');
});

test('a confidence score and a review of an older commit show on the reviewer', () => {
  const [first] = report([
    {
      pr: pr(1),
      snapshot: snapshot({
        reviews: [
          {
            user: { login: 'greptile-apps[bot]' },
            commit_id: 'old',
            submitted_at: ago(30),
            state: 'COMMENTED',
            body: 'Confidence Score: 4/5',
          },
        ],
      }),
    },
  ]);
  assert.deepEqual(first!.reviewers[0], {
    login: 'greptile-apps[bot]',
    mark: 'stale',
    onHead: false,
    verdict: 'commented',
    score: { score: 4, total: 5 },
    at: ago(30),
  });
});

test('a stacked pull request follows its base, with its place in the stack', () => {
  const reports = report([
    { pr: pr(2), snapshot: snapshot({ branch: 'feat-b', base: 'feat-a' }) },
    { pr: pr(1), snapshot: snapshot() },
  ]);
  assert.deepEqual(
    reports.map(({ number, stack }) => ({ number, stack })),
    [
      { number: 1, stack: { parent: null, position: 1, size: 2 } },
      { number: 2, stack: { parent: 'acme/web#1', position: 2, size: 2 } },
    ],
  );
});

test('a local session makes the agent Claude Code, with the state of the session', () => {
  const [first] = report(
    [{ pr: pr(1), snapshot: snapshot({ agent: { id: 'copilot', name: 'Copilot' } }) }],
    new Map([['acme/web#1', { session, linkedAt: now }]]),
  );
  assert.deepEqual(first!.agent, { kind: 'claude', session: 'web-2', sessionState: 'working', cloudSession: null });
});

test('a pull request with no agent and no session says none', () => {
  const [first] = report([{ pr: pr(1), snapshot: snapshot() }]);
  assert.deepEqual(first!.agent, { kind: null, session: null, sessionState: 'none', cloudSession: null });
});

test('a merged pull request, a draft and an unreadable one keep their place, with no summary', () => {
  const reports = report([
    { pr: pr(1), snapshot: snapshot({ status: 'merged' }) },
    { pr: pr(2), snapshot: snapshot({ status: 'draft', branch: 'feat-b' }) },
    { pr: pr(3), error: 'HTTP 502' },
  ]);
  assert.deepEqual(
    reports.map(({ number, state, isDraft, error, reviewers }) => ({ number, state, isDraft, error, reviewers })),
    [
      { number: 1, state: 'merged', isDraft: false, error: null, reviewers: [] },
      { number: 2, state: 'draft', isDraft: true, error: null, reviewers: [] },
      { number: 3, state: 'error', isDraft: false, error: 'HTTP 502', reviewers: [] },
    ],
  );
});

test('the output is valid JSON', () => {
  const reports = report([{ pr: pr(1), snapshot: snapshot() }]);
  assert.deepEqual(JSON.parse(JSON.stringify(reports)), reports);
});

test('a CodeRabbit rate limit on a merged pull request delays the open ones', () => {
  const limit = (id: number, minutes: number, minutesAgo: number) => ({
    id,
    user: { login: 'coderabbitai[bot]' },
    body: `Review rate limited. available in ${minutes} minutes.`,
    created_at: ago(minutesAgo),
    updated_at: ago(minutesAgo),
  });
  const open: ReportInput = { pr: pr(2), snapshot: snapshot({ branch: 'feat-b', comments: [limit(8, 2, 60)] }) };
  assert.equal(report([open])[0]!.notes.coderabbit?.kind, 'trigger');

  const merged: ReportInput = { pr: pr(1), snapshot: snapshot({ status: 'merged', comments: [limit(7, 30, 5)] }) };
  assert.equal(report([merged, open]).find(({ number }) => number === 2)!.notes.coderabbit?.kind, 'wait');
});

test('a ready pull request that misses a rule of the merge policy is approved, with the rule', () => {
  const approved: ReportInput = {
    pr: pr(1),
    snapshot: snapshot({
      reviews: [{ user: { login: 'alice' }, commit_id: 'abc123', submitted_at: ago(5), state: 'APPROVED' }],
      body: 'A change.',
    }),
  };
  const settings = { ...DEFAULT_SETTINGS, mergePolicy: { requireProof: '\\.gif|No /tfp:' } };
  const [missing] = buildReport([approved], new Map(), settings, now);
  assert.equal(missing!.state, 'approved');
  assert.deepEqual(missing!.policy, [{ rule: 'requireProof', note: 'no proof' }]);
  const proved = { ...approved, snapshot: { ...approved.snapshot!, body: 'Recording: demo.gif' } };
  assert.equal(buildReport([proved], new Map(), settings, now)[0]!.state, 'ready to merge');
});

const HOUR_AGO = ago(60);

test('a red pull request with no working session and an old head commit is stalled', () => {
  const stall = (patch: Partial<Parameters<typeof stallOf>[0]>) =>
    stallOf({ overall: 'checks failing', headAt: HOUR_AGO, working: false, afterMinutes: 30, now, ...patch });
  assert.deepEqual(stall({}), { stalled: true, idleMinutes: 60 });
  assert.deepEqual(stall({ overall: 'conflicts' }).stalled, true);
  assert.deepEqual(stall({ overall: 'changes requested' }).stalled, true);
  assert.deepEqual(stall({ overall: 'awaiting review' }), { stalled: false, idleMinutes: 60 });
  assert.deepEqual(stall({ working: true }).stalled, false);
  assert.deepEqual(stall({ afterMinutes: 90 }).stalled, false);
  assert.deepEqual(stall({ headAt: undefined }), { stalled: false, idleMinutes: null });
});

test('a waiting session does not keep a pull request from stalling, and a busy one does', () => {
  const failing: ReportInput = {
    pr: pr(1),
    snapshot: snapshot({ headAt: HOUR_AGO, checks: [{ name: 'Migrations', state: 'failure' }] }),
  };
  const owned = (status: string) => new Map([['acme/web#1', { session: { ...session, status }, linkedAt: now }]]);
  assert.equal(report([failing], owned('waiting'))[0]!.stalled, true);
  assert.equal(report([failing], owned('busy'))[0]!.stalled, false);
  assert.equal(report([failing])[0]!.idleMinutes, 60);
});

test('a merged or closed pull request is never stalled', () => {
  const left = (status: 'merged' | 'closed', number: number): ReportInput => ({
    pr: pr(number),
    snapshot: snapshot({
      status,
      branch: `b${number}`,
      headAt: HOUR_AGO,
      checks: [{ name: 'Migrations', state: 'failure' }],
    }),
  });
  for (const report of buildReport([left('merged', 1), left('closed', 2)], new Map(), DEFAULT_SETTINGS, now))
    assert.equal(report.stalled, false);
});
