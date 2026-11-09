import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRelayUrl, parseStoredRelay, probeRelay } from './relay-url';

test('a typed relay gets https and loses its trailing slash; http only on this machine', () => {
  assert.deepEqual(checkRelayUrl(' relay.example.com/ '), { url: 'https://relay.example.com' });
  assert.deepEqual(checkRelayUrl('http://localhost:4621'), { url: 'http://localhost:4621' });
  assert.deepEqual(checkRelayUrl('http://127.0.0.1:4621/'), { url: 'http://127.0.0.1:4621' });
  assert.deepEqual(checkRelayUrl('https://relay.example.com/boo'), { url: 'https://relay.example.com/boo' });
  assert.match(checkRelayUrl('http://relay.example.com').error!, /is not HTTPS/);
  assert.match(checkRelayUrl('https://exa mple').error!, /is not a URL/);
  assert.match(checkRelayUrl('   ').error!, /Type the URL/);
  assert.match(checkRelayUrl('https://me:pw@relay.example.com').error!, /no user/);
  assert.match(checkRelayUrl('https://relay.example.com/?a=1').error!, /no query/);
});

test('a stored relay is used only if it passes the check', () => {
  assert.equal(parseStoredRelay('https://relay.example.com'), 'https://relay.example.com');
  assert.equal(parseStoredRelay('http://relay.example.com'), undefined);
  assert.equal(parseStoredRelay(null), undefined);
});

test('the probe accepts a boo relay and names the problem of anything else', async () => {
  const answer = (status: number, body: string) => {
    const calls: RequestInit[] = [];
    const fetchFn = (async (_url: string, init: RequestInit = {}) => {
      calls.push(init);
      return new Response(body, { status });
    }) as typeof fetch;
    return { calls, fetchFn };
  };
  const url = 'https://relay.test';
  const boo = answer(200, JSON.stringify({ name: 'boo-relay', clientId: 'Iv1.app' }));
  assert.equal(await probeRelay(url, boo.fetchFn), undefined);
  // No token goes to a relay that is not checked yet.
  assert.equal(boo.calls[0]!.headers, undefined);
  assert.equal(boo.calls[0]!.redirect, 'error');
  assert.equal(await probeRelay(url, answer(200, '<!doctype html>').fetchFn), 'https://relay.test is not a boo relay.');
  assert.equal(
    await probeRelay(url, answer(200, JSON.stringify({ name: 'boo-relay' })).fetchFn),
    'https://relay.test is not a boo relay.',
  );
  assert.equal(
    await probeRelay(url, answer(500, JSON.stringify({ name: 'boo-relay', clientId: 'x' })).fetchFn),
    'https://relay.test is not a boo relay.',
  );
  const down = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  assert.equal(await probeRelay(url, down), 'No relay answers at https://relay.test.');
  const quiet = ((_url: string, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('cancelled')));
    })) as unknown as typeof fetch;
  assert.equal(await probeRelay(url, quiet, 20), 'https://relay.test did not answer in 0.02 s.');
});
