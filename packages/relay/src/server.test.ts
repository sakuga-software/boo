import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { GitHubError, type GitHubApi, type Tokens } from './github.js';
import { createRelay } from './server.js';
import { SessionStore } from './sessions.js';

const SECRET = 'webhook secret';

interface FakeGitHub extends GitHubApi {
  /** The repositories of each user token. */
  repos: Map<string, string[]>;
  repoReads: number;
  refreshes: string[];
}

const USERS = new Map([
  ['ghu_alice', { id: 1, login: 'alice' }],
  ['ghu_bob', { id: 2, login: 'bob' }],
]);

/** The fake gives `ghu_alice_2` after a refresh of the token of alice. */
const userOf = (token: string) => token.replace(/_2$/, '');

function fakeGitHub(): FakeGitHub {
  const fake: FakeGitHub = {
    repos: new Map([
      ['ghu_alice', ['acme/web']],
      ['ghu_bob', ['acme/secret']],
    ]),
    repoReads: 0,
    refreshes: [],
    checkToken: async (token) => USERS.get(userOf(token)),
    refresh: async (refreshToken): Promise<Tokens> => {
      fake.refreshes.push(refreshToken);
      if (refreshToken !== 'ghr_alice') throw new GitHubError('bad refresh token', 401);
      return { accessToken: 'ghu_alice_2', refreshToken: 'ghr_alice_2', expiresAt: Date.now() + 8 * 3_600_000 };
    },
    installations: async (token) => (fake.repos.has(userOf(token)) ? [{ id: 9, account: 'acme' }] : []),
    repositories: async (token) => {
      fake.repoReads++;
      const repos = fake.repos.get(userOf(token));
      if (!repos) throw new GitHubError('Bad credentials', 401);
      return repos;
    },
  };
  return fake;
}

async function startRelay(
  t: TestContext,
  gitHub = fakeGitHub(),
  extra: { accessTtlMs?: number; heartbeatMs?: number; now?: () => number } = {},
) {
  const store = new SessionStore(join(await mkdtemp(join(tmpdir(), 'relay-')), 'sessions.json'), 'key');
  const relay = createRelay({
    gitHub,
    store,
    webhookSecret: SECRET,
    clientId: 'Iv1.abc',
    appSlug: 'boo-relay',
    ...extra,
  });
  const server: Server = createServer(relay.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, gitHub, store, relay };
}

function deliver(base: string, type: string, payload: object, secret = SECRET) {
  const body = JSON.stringify(payload);
  return fetch(`${base}/webhooks`, {
    method: 'POST',
    headers: {
      'x-github-event': type,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    body,
  });
}

async function login(base: string, accessToken: string, extra: object = {}): Promise<string> {
  const response = await fetch(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ accessToken, ...extra }) });
  assert.equal(response.status, 201);
  return ((await response.json()) as { session: string }).session;
}

/** Opens the event stream and gives the events as they arrive. */
async function stream(t: TestContext, base: string, session: string, lastEventId?: string) {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${base}/events`, {
    headers: { authorization: `Bearer ${session}`, ...(lastEventId && { 'last-event-id': lastEventId }) },
    signal: abort.signal,
  });
  const events: { id?: string; event: string; data: Record<string, unknown> }[] = [];
  let ended = false;
  if (response.ok && response.body) {
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const fields = Object.fromEntries(
              block
                .split('\n')
                .filter((line) => !line.startsWith(':'))
                .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
            ) as Record<string, string>;
            if (fields.event)
              events.push({
                ...(fields.id && { id: fields.id }),
                event: fields.event,
                data: JSON.parse(fields.data ?? '{}'),
              });
          }
        }
      } catch {
        // The test aborted the stream.
      }
      ended = true;
    })();
  }
  const until = async (check: () => boolean, what: string) => {
    const end = Date.now() + 2_000;
    while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check(), `No ${what}. Events: ${JSON.stringify(events)}`);
  };
  return { response, events, until, ended: () => ended };
}

test('the root gives the client id and the install URL, and the health check answers', async (t) => {
  const { base } = await startRelay(t);
  assert.deepEqual(await (await fetch(base)).json(), {
    name: 'boo-relay',
    clientId: 'Iv1.abc',
    installUrl: 'https://github.com/apps/boo-relay/installations/new',
  });
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true, streams: 0 });
  assert.equal((await fetch(`${base}/nowhere`)).status, 404);
});

test('a webhook with a wrong signature is refused, and relays nothing', async (t) => {
  const { base, relay } = await startRelay(t);
  const response = await deliver(base, 'pull_request', { number: 1, repository: { full_name: 'acme/web' } }, 'wrong');
  assert.equal(response.status, 401);
  const published = relay.hub.publish({ type: 'probe', repo: 'acme/web' });
  assert.match(published.id, /-1$/);
});

test('a session needs a token of the App, and a request needs a session', async (t) => {
  const { base } = await startRelay(t);
  assert.equal((await fetch(`${base}/sessions`, { method: 'POST', body: '{}' })).status, 400);
  assert.equal(
    (await fetch(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ accessToken: 'ghp_other' }) })).status,
    401,
  );
  assert.equal((await fetch(`${base}/events`)).status, 401);
  assert.equal((await fetch(`${base}/events`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(`${base}/installations`)).status, 401);
});

test('a webhook reaches the streams that read its repository, and only those', async (t) => {
  const { base } = await startRelay(t);
  const alice = await stream(t, base, await login(base, 'ghu_alice'));
  const bob = await stream(t, base, await login(base, 'ghu_bob'));
  assert.equal(alice.response.headers.get('content-type'), 'text/event-stream');
  await alice.until(() => alice.events.some((event) => event.event === 'ready'), 'ready event');
  await bob.until(() => bob.events.some((event) => event.event === 'ready'), 'ready event');

  const response = await deliver(base, 'pull_request', {
    action: 'synchronize',
    number: 7,
    repository: { full_name: 'ACME/Web' },
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { relayed: 1 });
  await alice.until(() => alice.events.some((event) => event.event === 'change'), 'change for alice');
  assert.deepEqual(alice.events.find((event) => event.event === 'change')?.data, {
    type: 'pull_request',
    action: 'synchronize',
    repo: 'ACME/Web',
    number: 7,
    at: alice.events.find((event) => event.event === 'change')?.data.at,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bob.events.filter((event) => event.event === 'change').length, 0);
});

test('a stream that resumes gets the events that it missed, or a reset', async (t) => {
  const { base } = await startRelay(t);
  const session = await login(base, 'ghu_alice');
  const first = await stream(t, base, session);
  await first.until(() => first.events.some((event) => event.event === 'ready'), 'ready event');
  await deliver(base, 'pull_request', { number: 1, repository: { full_name: 'acme/web' } });
  await first.until(() => first.events.some((event) => event.event === 'change'), 'first change');
  const lastId = first.events.find((event) => event.event === 'change')!.id!;
  await deliver(base, 'issue_comment', {
    issue: { number: 2, pull_request: {} },
    repository: { full_name: 'acme/web' },
  });

  const resumed = await stream(t, base, session, lastId);
  await resumed.until(() => resumed.events.some((event) => event.event === 'change'), 'missed change');
  assert.deepEqual(
    resumed.events.filter((event) => event.event === 'change').map((event) => event.data.number),
    [2],
  );
  const reset = await stream(t, base, session, 'old-boot-1');
  await reset.until(() => reset.events.some((event) => event.event === 'reset'), 'reset event');
});

test('an installation event reads the access again: a new repository starts to flow', async (t) => {
  const { base, gitHub } = await startRelay(t);
  const alice = await stream(t, base, await login(base, 'ghu_alice'));
  await alice.until(() => alice.events.some((event) => event.event === 'ready'), 'ready event');
  gitHub.repos.set('ghu_alice', ['acme/web', 'acme/api']);
  await deliver(base, 'installation_repositories', { action: 'added', repository: undefined });
  await alice.until(() => gitHub.repoReads >= 2, 'second read of the access');
  await deliver(base, 'pull_request', { number: 3, repository: { full_name: 'acme/api' } });
  await alice.until(() => alice.events.some((event) => event.data.repo === 'acme/api'), 'change of the new repository');
});

test('after an access webhook, a removed repository sends nothing while the access is read again', async (t) => {
  const gitHub = fakeGitHub();
  const { base } = await startRelay(t, gitHub);
  const alice = await stream(t, base, await login(base, 'ghu_alice'));
  await alice.until(() => alice.events.some((event) => event.event === 'ready'), 'ready event');
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { repositories } = gitHub;
  gitHub.repositories = async (token) => {
    await held;
    gitHub.repos.set('ghu_alice', []);
    return repositories(token);
  };
  await deliver(base, 'installation_repositories', { action: 'removed' });
  await deliver(base, 'pull_request', { number: 1, repository: { full_name: 'acme/web' } });
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await deliver(base, 'pull_request', { number: 2, repository: { full_name: 'acme/web' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alice.events.filter((event) => event.event === 'change').length, 0);
});

test('the access stays for its time: a second stream reads no GitHub', async (t) => {
  const { base, gitHub } = await startRelay(t);
  const session = await login(base, 'ghu_alice');
  const one = await stream(t, base, session);
  await one.until(() => one.events.some((event) => event.event === 'ready'), 'ready event');
  const two = await stream(t, base, session);
  await two.until(() => two.events.some((event) => event.event === 'ready'), 'ready event');
  assert.equal(gitHub.repoReads, 1);
});

test('an expired token is refreshed before a read, and kept for the next restart', async (t) => {
  const { base, gitHub, store } = await startRelay(t);
  const session = await login(base, 'ghu_alice', { refreshToken: 'ghr_alice', expiresIn: 60 });
  const response = await fetch(`${base}/installations`, { headers: { authorization: `Bearer ${session}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    installations: [{ id: 9, account: 'acme' }],
    installUrl: 'https://github.com/apps/boo-relay/installations/new',
  });
  assert.deepEqual(gitHub.refreshes, ['ghr_alice']);
  assert.equal(store.byToken(session)?.tokens.accessToken, 'ghu_alice_2');
});

test('a refresh whose write fails still answers, with the new token kept in memory', async (t) => {
  const { base, store, gitHub } = await startRelay(t);
  const session = await login(base, 'ghu_alice', { refreshToken: 'ghr_alice', expiresIn: 60 });
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (error: unknown) => logged.push(error);
  t.after(() => {
    console.error = original;
  });
  // The store changes its memory, then the write to the file fails.
  const update = store.update.bind(store);
  store.update = async (id, tokens) => {
    await update(id, tokens);
    throw new Error('EACCES');
  };
  const auth = { headers: { authorization: `Bearer ${session}` } };
  assert.equal((await fetch(`${base}/installations`, auth)).status, 200);
  assert.equal(logged.length, 1);
  assert.equal((await fetch(`${base}/installations`, auth)).status, 200);
  assert.deepEqual(gitHub.refreshes, ['ghr_alice']);
});

test('a token that cannot be refreshed, or that GitHub revoked, ends the session', async (t) => {
  const { base, gitHub } = await startRelay(t);
  const refused = await login(base, 'ghu_alice', { refreshToken: 'ghr_revoked', expiresIn: 60 });
  const response = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${refused}` } });
  assert.equal(response.status, 401);
  assert.match(((await response.json()) as { error: string }).error, /run boo setup-webhooks again/);
  assert.equal((await fetch(`${base}/installations`, { headers: { authorization: `Bearer ${refused}` } })).status, 401);

  const revoked = await login(base, 'ghu_alice');
  gitHub.installations = async () => {
    throw new GitHubError('Bad credentials', 401);
  };
  assert.equal((await fetch(`${base}/installations`, { headers: { authorization: `Bearer ${revoked}` } })).status, 401);
  assert.equal((await fetch(`${base}/events`, { headers: { authorization: `Bearer ${revoked}` } })).status, 401);

  const noRefresh = await login(base, 'ghu_alice', { expiresIn: 60 });
  assert.equal(
    (await fetch(`${base}/installations`, { headers: { authorization: `Bearer ${noRefresh}` } })).status,
    401,
  );
});

test('a token that GitHub revoked during a stream closes the stream, and leaves no subscriber', async (t) => {
  const { base, gitHub, relay } = await startRelay(t, fakeGitHub(), { accessTtlMs: 0, heartbeatMs: 20 });
  const alice = await stream(t, base, await login(base, 'ghu_alice'));
  await alice.until(() => alice.events.some((event) => event.event === 'ready'), 'ready event');
  gitHub.repos.delete('ghu_alice');
  await alice.until(() => alice.events.some((event) => event.event === 'expired'), 'expired event');
  await alice.until(alice.ended, 'end of the stream');
  await alice.until(() => relay.hub.size === 0, 'no subscriber left');
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true, streams: 0 });
});

test('a failure of GitHub during a stream keeps the stream, and the relay logs it', async (t) => {
  const { base, gitHub, relay } = await startRelay(t, fakeGitHub(), { accessTtlMs: 0, heartbeatMs: 20 });
  const alice = await stream(t, base, await login(base, 'ghu_alice'));
  await alice.until(() => alice.events.some((event) => event.event === 'ready'), 'ready event');
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (error: unknown) => logged.push(error);
  t.after(() => {
    console.error = original;
  });
  gitHub.repositories = async () => {
    throw new GitHubError('GitHub answered 502', 502);
  };
  await alice.until(() => logged.length > 0, 'logged failure');
  assert.equal(relay.hub.size, 1);
  assert.equal(alice.ended(), false);
});

test('while GitHub fails to give the access again, the old list works for twice its time, then nothing flows', async (t) => {
  let clock = 0;
  const { base, gitHub } = await startRelay(t, fakeGitHub(), { accessTtlMs: 1_000, heartbeatMs: 20, now: () => clock });
  const alice = await stream(t, base, await login(base, 'ghu_alice'));
  await alice.until(() => alice.events.some((event) => event.event === 'ready'), 'ready event');
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  const { repositories } = gitHub;
  gitHub.repositories = async () => {
    throw new GitHubError('GitHub answered 502', 502);
  };
  const changes = () => alice.events.filter((event) => event.event === 'change').map((event) => event.data.number);
  const pull = (number: number) => deliver(base, 'pull_request', { number, repository: { full_name: 'acme/web' } });

  clock = 1_500;
  await pull(1);
  await alice.until(() => changes().includes(1), 'change within twice the time');

  clock = 2_500;
  await pull(2);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(changes(), [1]);

  gitHub.repositories = repositories;
  const reads = gitHub.repoReads;
  await alice.until(() => gitHub.repoReads > reads, 'read that works');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await pull(3);
  await alice.until(() => changes().includes(3), 'change after the read that works');
});

test('a failure of GitHub at the open of a stream opens it with no change, until a read works', async (t) => {
  const gitHub = fakeGitHub();
  const { repositories } = gitHub;
  gitHub.repositories = async () => {
    throw new GitHubError('GitHub answered 502', 502);
  };
  const { base } = await startRelay(t, gitHub, { heartbeatMs: 20 });
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  const alice = await stream(t, base, await login(base, 'ghu_alice'));
  assert.equal(alice.response.status, 200);
  await alice.until(() => alice.events.some((event) => event.event === 'ready'), 'ready event');
  await deliver(base, 'pull_request', { number: 1, repository: { full_name: 'acme/web' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(alice.events.filter((event) => event.event === 'change').length, 0);

  gitHub.repositories = repositories;
  await alice.until(() => gitHub.repoReads > 0, 'read that works');
  // The stream dropped the first change, so the watch must read all.
  await alice.until(() => alice.events.some((event) => event.event === 'reset'), 'reset after the dropped change');
  await deliver(base, 'pull_request', { number: 2, repository: { full_name: 'acme/web' } });
  await alice.until(
    () => alice.events.some((event) => event.event === 'change' && event.data.number === 2),
    'change after the read that works',
  );
});

test('a resume while the access is not valid gets a reset, not a filtered replay', async (t) => {
  const gitHub = fakeGitHub();
  const { base } = await startRelay(t, gitHub);
  const session = await login(base, 'ghu_alice');
  const first = await stream(t, base, session);
  await first.until(() => first.events.some((event) => event.event === 'ready'), 'ready event');
  await deliver(base, 'pull_request', { number: 1, repository: { full_name: 'acme/web' } });
  await first.until(() => first.events.some((event) => event.event === 'change'), 'first change');
  const lastId = first.events.find((event) => event.event === 'change')!.id!;

  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  gitHub.repositories = async () => {
    throw new GitHubError('GitHub answered 502', 502);
  };
  await deliver(base, 'installation_repositories', { action: 'added' });
  await deliver(base, 'pull_request', { number: 2, repository: { full_name: 'acme/web' } });

  const resumed = await stream(t, base, session, lastId);
  await resumed.until(() => resumed.events.some((event) => event.event === 'reset'), 'reset event');
  assert.equal(resumed.events.filter((event) => event.event === 'change').length, 0);
});

test('a session deleted during the read of the access of a stream gets a 401, and no stream', async (t) => {
  const gitHub = fakeGitHub();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { repositories } = gitHub;
  gitHub.repositories = async (token) => {
    await held;
    return repositories(token);
  };
  const { base, relay } = await startRelay(t, gitHub);
  const session = await login(base, 'ghu_alice');
  const auth = { authorization: `Bearer ${session}` };
  const opened = fetch(`${base}/events`, { headers: auth });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await fetch(`${base}/sessions`, { method: 'DELETE', headers: auth })).status, 204);
  release();
  assert.equal((await opened).status, 401);
  assert.equal(relay.hub.size, 0);
});

test('a client that leaves during the read of its access leaves no subscriber', async (t) => {
  const gitHub = fakeGitHub();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { repositories } = gitHub;
  gitHub.repositories = async (token) => {
    await held;
    return repositories(token);
  };
  const { base, relay } = await startRelay(t, gitHub);
  const session = await login(base, 'ghu_alice');
  const abort = new AbortController();
  const opened = fetch(`${base}/events`, { headers: { authorization: `Bearer ${session}` }, signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 50));
  abort.abort();
  await assert.rejects(opened);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(relay.hub.size, 0);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true, streams: 0 });
});

test('a body that is not JSON gives a 400', async (t) => {
  const { base } = await startRelay(t);
  const body = 'not json';
  const signed = await fetch(`${base}/webhooks`, {
    method: 'POST',
    headers: {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    body,
  });
  assert.equal(signed.status, 400);
  assert.equal((await fetch(`${base}/sessions`, { method: 'POST', body })).status, 400);
});

test('a deleted session ends its open streams, keeps the others, and cannot open a stream', async (t) => {
  const { base, relay } = await startRelay(t);
  const session = await login(base, 'ghu_alice');
  const auth = { authorization: `Bearer ${session}` };
  const open = await stream(t, base, session);
  const bob = await stream(t, base, await login(base, 'ghu_bob'));
  await open.until(() => open.events.some((event) => event.event === 'ready'), 'ready event');
  await bob.until(() => bob.events.some((event) => event.event === 'ready'), 'ready event');
  assert.equal((await fetch(`${base}/sessions`, { method: 'DELETE', headers: auth })).status, 204);
  await open.until(() => open.events.some((event) => event.event === 'expired'), 'expired event');
  await open.until(open.ended, 'end of the stream');
  assert.equal(relay.hub.size, 1);
  assert.equal(bob.ended(), false);
  assert.equal((await fetch(`${base}/events`, { headers: auth })).status, 401);
});

test('a failure of GitHub gives a 500 with no detail', async (t) => {
  const gitHub = fakeGitHub();
  gitHub.checkToken = async () => {
    throw new Error('socket hang up with secret detail');
  };
  const { base } = await startRelay(t, gitHub);
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  const response = await fetch(`${base}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ accessToken: 'ghu_alice' }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'The relay failed' });
});
