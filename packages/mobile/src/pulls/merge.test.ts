import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canMergeIn, mergedDetail, mergePull, type MergeRequest } from './merge';

const connection = { url: 'https://relay.test', session: 'session-1', login: 'mheaus' };
const request: MergeRequest = {
  repo: 'acme/web',
  number: 12,
  method: 'squash',
  deleteBranch: true,
  sha: 'a'.repeat(40),
};

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('the merge goes to POST /merge with the session, the method, the branch and the head', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ merged: true, sha: 'b1', branchDeleted: true }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await mergePull(connection, fetchFn, request), { status: 'merged', sha: 'b1', branchDeleted: true });
  assert.equal(seen!.url, 'https://relay.test/merge');
  assert.equal(seen!.init.method, 'POST');
  assert.equal(seen!.init.redirect, 'error');
  assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer session-1');
  assert.deepEqual(JSON.parse(seen!.init.body as string), request);
});

test('each refusal of the relay gives its own result, with the message of GitHub', async () => {
  assert.deepEqual(await mergePull(connection, answer(403, { error: 'no write', code: 'no-write' }), request), {
    status: 'no-write',
    message: 'no write',
  });
  assert.deepEqual(
    await mergePull(connection, answer(409, { error: 'At least 1 approving review is required' }), request),
    { status: 'refused', message: 'At least 1 approving review is required' },
  );
  assert.deepEqual(await mergePull(connection, answer(401, {}), request), { status: 'expired' });
  assert.deepEqual(await mergePull(connection, answer(404, { error: 'not found' }), request), {
    status: 'no-write',
    message: 'This relay cannot merge: update it.',
  });
  assert.deepEqual(await mergePull(connection, answer(502, { error: 'GitHub did not merge' }), request), {
    status: 'failed',
    message: 'GitHub did not merge',
  });
});

test('a relay that does not answer gives a failure that sends the person to GitHub', async (t) => {
  // The timer of AbortSignal.timeout does not hold the event loop, and the fake holds nothing: Node 22 can end the test first.
  const hold = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(hold));
  const quiet = ((_url: string, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
  assert.deepEqual(await mergePull(connection, quiet, request, 20), {
    status: 'failed',
    message: 'The relay did not answer in 0.02 s. Check the pull request on GitHub.',
  });
  const down = (async () => {
    throw new TypeError('Network request failed');
  }) as unknown as typeof fetch;
  assert.deepEqual(await mergePull(connection, down, request), {
    status: 'failed',
    message: 'The relay did not answer. Try again later.',
  });
});

test('the sheet says how the merge went, and whether the App can merge in an account', () => {
  assert.equal(mergedDetail('squash', true), 'Squashed · branch deleted');
  assert.equal(mergedDetail('rebase', false), 'Rebased');
  const installations = [{ account: 'Sakuga-Software', canMerge: true }, { account: 'mheaus' }];
  assert.equal(canMergeIn(installations, 'sakuga-software'), true);
  assert.equal(canMergeIn(installations, 'mheaus'), undefined);
  assert.equal(canMergeIn(undefined, 'acme'), undefined);
});
