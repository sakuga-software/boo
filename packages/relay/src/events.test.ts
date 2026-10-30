import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { changesAccess, changesOf } from './events.js';
import { validSignature } from './signature.js';

const repository = { full_name: 'acme/web' };

test('a pull request, a review, a review comment and a thread name their pull request', () => {
  assert.deepEqual(changesOf('pull_request', { action: 'opened', number: 7, repository }), [
    { type: 'pull_request', action: 'opened', repo: 'acme/web', number: 7 },
  ]);
  for (const type of ['pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread'])
    assert.deepEqual(changesOf(type, { action: 'submitted', pull_request: { number: 7 }, repository }), [
      { type, action: 'submitted', repo: 'acme/web', number: 7 },
    ]);
});

test('a comment on a pull request gives a change, a comment on an issue gives none', () => {
  const comment = (issue: object) => changesOf('issue_comment', { action: 'created', issue, repository });
  assert.deepEqual(comment({ number: 7, pull_request: { url: 'x' } }), [
    { type: 'issue_comment', action: 'created', repo: 'acme/web', number: 7 },
  ]);
  assert.deepEqual(comment({ number: 8 }), []);
});

test('a check names each of its pull requests, or its commit if it names none', () => {
  const run = (pull_requests: object[]) => ({ head_sha: 'abc', pull_requests });
  assert.deepEqual(
    changesOf('check_run', { action: 'completed', check_run: run([{ number: 1 }, { number: 2 }]), repository }),
    [
      { type: 'check_run', action: 'completed', repo: 'acme/web', number: 1 },
      { type: 'check_run', action: 'completed', repo: 'acme/web', number: 2 },
    ],
  );
  assert.deepEqual(changesOf('check_suite', { check_suite: run([]), repository }), [
    { type: 'check_suite', repo: 'acme/web', sha: 'abc' },
  ]);
  assert.deepEqual(changesOf('workflow_run', { workflow_run: run([{ number: 3 }]), repository }), [
    { type: 'workflow_run', repo: 'acme/web', number: 3 },
  ]);
  assert.deepEqual(changesOf('status', { sha: 'def', repository }), [{ type: 'status', repo: 'acme/web', sha: 'def' }]);
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
