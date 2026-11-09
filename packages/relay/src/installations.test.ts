import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { test } from 'node:test';
import { appJwt, installationReader } from './installations.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { appId: '123', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

test('the JWT of the App is signed with its key, and lives less than 10 minutes', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const [header, payload, signature] = appJwt(key, now).split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, '123');
  assert.ok(claims.iat < now / 1000, 'iat is before now, for a clock of GitHub a little behind');
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(
    createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')),
  );
});

function fakeGitHub() {
  const calls: string[] = [];
  let tokenCount = 0;
  let failList = false;
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const path = input.replace('https://api.test', '');
    calls.push(`${init.method ?? 'GET'} ${path}`);
    assert.match((init.headers as Record<string, string>).authorization ?? '', /^Bearer ey/);
    if (path.startsWith('/app/installations?')) {
      if (failList) return new Response('', { status: 502 });
      return Response.json([
        { id: 1, account: { login: 'Acme' } },
        { id: 2, account: null },
      ]);
    }
    if (path === '/app/installations/1/access_tokens') {
      tokenCount++;
      return Response.json({ token: `ghs_${tokenCount}`, expires_at: new Date(clock + 60 * 60_000).toISOString() });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  let clock = Date.parse('2026-11-09T12:00:00Z');
  return {
    calls,
    fetchFn,
    now: () => clock,
    advance: (ms: number) => void (clock += ms),
    failList: (value: boolean) => void (failList = value),
  };
}

test('a token of an installation is kept until 5 minutes before its end, and two calls share one request', async () => {
  const github = fakeGitHub();
  const reader = installationReader(key, { fetch: github.fetchFn, apiUrl: 'https://api.test', now: github.now });
  const [first, second] = await Promise.all([reader.tokenFor('acme'), reader.tokenFor('ACME')]);
  assert.equal(first, 'ghs_1');
  assert.equal(second, 'ghs_1');
  github.advance(54 * 60_000);
  assert.equal(await reader.tokenFor('acme'), 'ghs_1');
  github.advance(2 * 60_000);
  assert.equal(await reader.tokenFor('acme'), 'ghs_2');
  assert.equal(github.calls.filter((call) => call.endsWith('/access_tokens')).length, 2);
});

test('an account with no installation has no token, and a failed list is read again', async () => {
  const github = fakeGitHub();
  const reader = installationReader(key, { fetch: github.fetchFn, apiUrl: 'https://api.test', now: github.now });
  github.failList(true);
  await assert.rejects(reader.tokenFor('acme'), /502/);
  github.failList(false);
  assert.equal(await reader.tokenFor('other'), undefined);
  assert.deepEqual([...(await reader.installations()).keys()], ['acme']);
  // The list stays 10 minutes.
  const lists = () => github.calls.filter((call) => call.startsWith('GET /app/installations')).length;
  assert.equal(lists(), 2);
  github.advance(10 * 60_000);
  await reader.installations();
  assert.equal(lists(), 3);
});
