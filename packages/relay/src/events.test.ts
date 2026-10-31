import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { changesAccess, changesOf } from './events.js';
import { validSignature } from './signature.js';

const repository = { full_name: 'acme/web' };

/** The fields that route a change, with no data. */
const route = (changes: ReturnType<typeof changesOf>) => changes.map(({ data: _data, ...fields }) => fields);

test('a pull request, a review, a review comment and a thread name their pull request', () => {
  assert.deepEqual(route(changesOf('pull_request', { action: 'opened', number: 7, repository })), [
    { type: 'pull_request', action: 'opened', repo: 'acme/web', number: 7 },
  ]);
  for (const type of ['pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread'])
    assert.deepEqual(route(changesOf(type, { action: 'submitted', pull_request: { number: 7 }, repository })), [
      { type, action: 'submitted', repo: 'acme/web', number: 7 },
    ]);
});

test('a comment on a pull request gives a change, a comment on an issue gives none', () => {
  const comment = (issue: object) => changesOf('issue_comment', { action: 'created', issue, repository });
  assert.deepEqual(route(comment({ number: 7, pull_request: { url: 'x' } })), [
    { type: 'issue_comment', action: 'created', repo: 'acme/web', number: 7 },
  ]);
  assert.deepEqual(comment({ number: 8 }), []);
});

test('a check names each of its pull requests, or its commit if it names none', () => {
  const run = (pull_requests: object[]) => ({ head_sha: 'abc', pull_requests });
  assert.deepEqual(
    route(changesOf('check_run', { action: 'completed', check_run: run([{ number: 1 }, { number: 2 }]), repository })),
    [
      { type: 'check_run', action: 'completed', repo: 'acme/web', number: 1 },
      { type: 'check_run', action: 'completed', repo: 'acme/web', number: 2 },
    ],
  );
  assert.deepEqual(route(changesOf('check_suite', { check_suite: run([]), repository })), [
    { type: 'check_suite', repo: 'acme/web', sha: 'abc' },
  ]);
  assert.deepEqual(route(changesOf('workflow_run', { workflow_run: run([{ number: 3 }]), repository })), [
    { type: 'workflow_run', repo: 'acme/web', number: 3 },
  ]);
  assert.deepEqual(route(changesOf('status', { sha: 'def', repository })), [
    { type: 'status', repo: 'acme/web', sha: 'def' },
  ]);
});

const dataOf = (type: string, payload: object) => changesOf(type, { repository, ...payload })[0]?.data;

test('a pull request carries its state, its head, its base and its requested reviewers', () => {
  const pull_request = {
    title: 'feat: relay',
    body: 'Closes #88',
    state: 'closed',
    draft: false,
    merged: true,
    merged_at: '2026-10-31T10:00:00Z',
    merged_by: { login: 'alice' },
    user: { login: 'bob' },
    head: { sha: 'abc', ref: 'feat/relay', repo: { full_name: 'bob/web' } },
    base: { ref: 'main', repo: { full_name: 'acme/web' } },
    mergeable_state: 'clean',
    requested_reviewers: [{ login: 'copilot-pull-request-reviewer[bot]' }],
    requested_teams: [{ slug: 'core' }],
    additions: 10,
    deletions: 2,
    changed_files: 3,
    updated_at: '2026-10-31T10:00:00Z',
  };
  assert.deepEqual(
    dataOf('pull_request', {
      action: 'closed',
      number: 7,
      pull_request,
      repository: { ...repository, default_branch: 'main' },
    }),
    {
      pullRequest: {
        title: 'feat: relay',
        body: 'Closes #88',
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: '2026-10-31T10:00:00Z',
        mergedBy: 'alice',
        author: 'bob',
        headSha: 'abc',
        headRef: 'feat/relay',
        fork: true,
        baseRef: 'main',
        defaultBranch: 'main',
        mergeableState: 'clean',
        requested: ['copilot-pull-request-reviewer[bot]', 'core'],
        additions: 10,
        deletions: 2,
        changedFiles: 3,
        updatedAt: '2026-10-31T10:00:00Z',
      },
    },
  );
});

test('a review and a comment carry their author, their text and their times', () => {
  assert.deepEqual(
    dataOf('pull_request_review', {
      pull_request: { number: 7 },
      review: {
        id: 1,
        user: { login: 'kento-review[bot]' },
        state: 'CHANGES_REQUESTED',
        body: 'Score 2/5',
        commit_id: 'abc',
        submitted_at: 't1',
      },
    }),
    {
      review: {
        id: 1,
        author: 'kento-review[bot]',
        state: 'changes_requested',
        body: 'Score 2/5',
        commitId: 'abc',
        submittedAt: 't1',
      },
    },
  );
  assert.deepEqual(
    dataOf('pull_request_review_comment', {
      pull_request: { number: 7 },
      comment: {
        id: 2,
        user: { login: 'alice' },
        body: 'Why?',
        created_at: 't1',
        updated_at: 't2',
        in_reply_to_id: 1,
        pull_request_review_id: 9,
        path: 'a.ts',
      },
    }),
    {
      comment: {
        id: 2,
        author: 'alice',
        body: 'Why?',
        createdAt: 't1',
        updatedAt: 't2',
        inReplyTo: 1,
        reviewId: 9,
        path: 'a.ts',
      },
    },
  );
  assert.deepEqual(
    dataOf('issue_comment', {
      issue: { number: 7, pull_request: {} },
      comment: {
        id: 3,
        user: { login: 'coderabbitai[bot]' },
        body: 'Rate limit exceeded',
        created_at: 't1',
        updated_at: 't3',
      },
    }),
    { comment: { id: 3, author: 'coderabbitai[bot]', body: 'Rate limit exceeded', createdAt: 't1', updatedAt: 't3' } },
  );
  assert.deepEqual(
    dataOf('pull_request_review_thread', {
      action: 'resolved',
      pull_request: { number: 7 },
      thread: { comments: [{ id: 4, user: { login: 'kento-review[bot]' }, body: 'P1' }, 'not an object'] },
    }),
    { thread: { resolved: true, comments: [{ id: 4, author: 'kento-review[bot]', body: 'P1' }, {}] } },
  );
});

test('a check, a suite, a status and a workflow run carry their state', () => {
  assert.deepEqual(
    dataOf('check_run', {
      check_run: {
        id: 1,
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        head_sha: 'abc',
        started_at: 't1',
        completed_at: 't2',
        details_url: 'https://x',
        check_suite: { id: 5 },
        app: { slug: 'github-actions' },
        pull_requests: [{ number: 7 }],
      },
    }),
    {
      checkRun: {
        id: 1,
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        headSha: 'abc',
        startedAt: 't1',
        completedAt: 't2',
        detailsUrl: 'https://x',
        suiteId: 5,
        app: 'github-actions',
      },
    },
  );
  assert.deepEqual(
    dataOf('check_suite', {
      check_suite: { id: 5, status: 'queued', head_sha: 'abc', app: { slug: 'github-actions' }, pull_requests: [] },
    }),
    { checkSuite: { id: 5, status: 'queued', headSha: 'abc', app: 'github-actions' } },
  );
  assert.deepEqual(
    dataOf('status', {
      sha: 'abc',
      context: 'CodeRabbit',
      state: 'success',
      description: 'Review rate limited',
      target_url: 'https://y',
    }),
    { status: { context: 'CodeRabbit', state: 'success', description: 'Review rate limited', targetUrl: 'https://y' } },
  );
  assert.deepEqual(
    dataOf('workflow_run', {
      workflow_run: {
        id: 6,
        name: 'CI',
        workflow_id: 2,
        status: 'queued',
        head_sha: 'abc',
        event: 'pull_request',
        run_attempt: 1,
        pull_requests: [{ number: 7 }],
      },
    }),
    {
      workflowRun: {
        id: 6,
        name: 'CI',
        workflowId: 2,
        status: 'queued',
        headSha: 'abc',
        event: 'pull_request',
        attempt: 1,
      },
    },
  );
});

test('a delivery with no repository, no number or an unknown type gives no change', () => {
  assert.deepEqual(changesOf('pull_request', { number: 7 }), []);
  assert.deepEqual(changesOf('pull_request', { repository }), []);
  assert.deepEqual(changesOf('check_run', { check_run: { pull_requests: [] }, repository }), []);
  assert.deepEqual(changesOf('push', { repository }), []);
});

test('the installation, member and repository events change the access, a review does not', () => {
  for (const type of [
    'installation',
    'installation_repositories',
    'member',
    'membership',
    'organization',
    'repository',
  ])
    assert.equal(changesAccess(type), true);
  assert.equal(changesAccess('pull_request_review'), false);
});

test('only the signature of the body with the secret is valid', () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(validSignature('s3cret', body, sign('s3cret')), true);
  assert.equal(validSignature('s3cret', body, sign('other')), false);
  assert.equal(validSignature('s3cret', body, 'sha256=short'), false);
  assert.equal(validSignature('s3cret', body, undefined), false);
  assert.equal(validSignature('s3cret', body, sign('s3cret').replace('sha256=', 'sha1=')), false);
});
