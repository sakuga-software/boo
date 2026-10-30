import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubError, gitHubApi } from './github.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(answer: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      ...(init.body && { body: JSON.parse(init.body as string) }),
    };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const app = { clientId: 'Iv1.abc', clientSecret: 'shh' };

test('a token check uses the credentials of the App, and a token of another App gives no user', async () => {
  const { calls, fetchFn } = fakeFetch(({ body }) =>
    (body as { access_token: string }).access_token === 'ghu_ok'
      ? { body: { user: { id: 1, login: 'alice', extra: true } } }
      : { status: 404, body: {} },
  );
  const gitHub = gitHubApi(app, fetchFn);
  assert.deepEqual(await gitHub.checkToken('ghu_ok'), { id: 1, login: 'alice' });
  assert.equal(await gitHub.checkToken('ghp_other'), undefined);
  assert.equal(calls[0]!.url, 'https://api.github.com/applications/Iv1.abc/token');
  assert.equal(calls[0]!.headers.authorization, `Basic ${Buffer.from('Iv1.abc:shh').toString('base64')}`);
});

test('a token check that GitHub cannot answer fails', async () => {
  const gitHub = gitHubApi(app, fakeFetch(() => ({ status: 502, body: {} })).fetchFn);
  await assert.rejects(gitHub.checkToken('ghu_ok'), (error) => error instanceof GitHubError && error.status === 502);
});

test('a refresh gives the new tokens and their end, and a refused refresh fails with 401', async () => {
  const { calls, fetchFn } = fakeFetch(({ body }) =>
    (body as { refresh_token: string }).refresh_token === 'ghr_ok'
      ? { body: { access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28_800 } }
      : { body: { error: 'bad_refresh_token' } },
  );
  const gitHub = gitHubApi(app, fetchFn, () => 1_000);
  assert.deepEqual(await gitHub.refresh('ghr_ok'), {
    accessToken: 'ghu_new',
    refreshToken: 'ghr_new',
    expiresAt: 1_000 + 28_800_000,
  });
  assert.deepEqual(calls[0]!.body, {
    client_id: 'Iv1.abc',
    client_secret: 'shh',
    grant_type: 'refresh_token',
    refresh_token: 'ghr_ok',
  });
  await assert.rejects(gitHub.refresh('ghr_bad'), (error) => error instanceof GitHubError && error.status === 401);
});

test('the repositories of a user come from each installation, page by page', async () => {
  const page = (count: number, offset: number) =>
    Array.from({ length: count }, (_, index) => ({ full_name: `acme/repo-${offset + index}` }));
  const { calls, fetchFn } = fakeFetch(({ url }) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/user/installations')
      return {
        body: {
          installations: [
            { id: 1, account: { login: 'acme' } },
            { id: 2, account: { login: 'alice' } },
          ],
        },
      };
    if (pathname === '/user/installations/1/repositories')
      return { body: { repositories: searchParams.get('page') === '1' ? page(100, 0) : page(1, 100) } };
    return { body: { repositories: [{ full_name: 'alice/dotfiles' }] } };
  });
  const gitHub = gitHubApi(app, fetchFn);
  const repos = await gitHub.repositories('ghu_ok');
  assert.equal(repos.length, 102);
  assert.ok(repos.includes('acme/repo-100'));
  assert.ok(repos.includes('alice/dotfiles'));
  assert.ok(calls.every((call) => call.headers.authorization === 'Bearer ghu_ok'));
  assert.deepEqual(await gitHub.installations('ghu_ok'), [
    { id: 1, account: 'acme' },
    { id: 2, account: 'alice' },
  ]);
});
