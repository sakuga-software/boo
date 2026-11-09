import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graphql, PullRequest } from '@sakuga-software/boo-core/github';
import { DEFAULT_SETTINGS, type Settings } from '@sakuga-software/boo-core/settings';
import { GitHubError } from './github.js';
import { StateStore } from './state-store.js';
import { pullReader, searchesOf, Tracker, type PullReader } from './tracker.js';

const pr = (number: number, repo = 'acme/web'): PullRequest => ({
  repo,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
});

/** A pull request node of the first GraphQL query, with one page of everything. */
const node = (head: string, state = 'OPEN') => ({
  title: 'A change',
  state,
  isDraft: false,
  merged: state === 'MERGED',
  mergeStateStatus: 'CLEAN',
  headRefOid: head,
  headRefName: 'feature',
  baseRefName: 'main',
  isCrossRepository: false,
  author: { login: 'alice', __typename: 'User' },
  reviewRequests: { nodes: [] },
  reviews: { nodes: [] },
  comments: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
});

interface FakeReader extends PullReader {
  searches: { owner: string; query: string }[];
  reads: string[];
  results: Map<string, PullRequest[]>;
  heads: Map<string, string>;
}

function fakeReader(): FakeReader {
  const fake: FakeReader = {
    searches: [],
    reads: [],
    results: new Map(),
    heads: new Map(),
    search: async (owner, query) => {
      fake.searches.push({ owner, query });
      return fake.results.get(owner) ?? [];
    },
    graphql: (owner): Graphql => {
      return async (_query, variables) => {
        const key = `${owner}/${variables.name}#${variables.number}`;
        fake.reads.push(key);
        const head = fake.heads.get(key);
        if (!head) throw new GitHubError('GitHub answered 502', 502);
        return { repository: { pullRequest: node(head) } };
      };
    },
  };
  return fake;
}

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

function setup(debounceMs = 5) {
  const store = new StateStore(':memory:');
  const reader = fakeReader();
  const reads: string[] = [];
  const tracker = new Tracker({
    store,
    reader,
    accounts: async () => ['acme', 'umbrella'],
    debounceMs,
    onRead: (read) => reads.push(`${read.repo}#${read.number}`),
    log: () => {},
  });
  return { store, reader, tracker, reads };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the searches cover each author in each account of the org, with @me as the user', () => {
  assert.deepEqual(
    searchesOf('alice', { org: 'acme', settings: settings({ authors: ['@me', 'bot'] }) }, ['acme', 'x']),
    [
      { owner: 'acme', query: 'is:pr is:open archived:false draft:false author:alice user:acme' },
      { owner: 'acme', query: 'is:pr is:open archived:false draft:false author:bot user:acme' },
    ],
  );
  assert.deepEqual(
    searchesOf('alice', { org: '', settings: settings({ drafts: 'show' }) }, ['acme', 'x']).map(({ query }) => query),
    ['is:pr is:open archived:false author:alice user:acme', 'is:pr is:open archived:false author:alice user:x'],
  );
});

test('the repositories of the settings give one search for each owner, and skip an owner with no installation', () => {
  const config = { org: '', settings: settings({ repos: ['acme/web', 'acme/api', 'Other/thing'] }) };
  assert.deepEqual(searchesOf('alice', config, ['acme']), [
    { owner: 'acme', query: 'is:pr is:open archived:false draft:false author:alice repo:acme/web repo:acme/api' },
  ]);
});

test('a user gets a first read of each pull request it follows, and a pull request is read once for two users', async () => {
  const { store, reader, tracker } = setup();
  reader.results.set('acme', [pr(1), pr(2)]);
  reader.heads.set('acme/web#1', 'a1');
  reader.heads.set('acme/web#2', 'a2');
  store.setConfig('alice', { org: 'acme', settings: settings() }, 0);
  store.setConfig('bob', { org: 'acme', settings: settings() }, 0);
  await tracker.refreshAll();
  assert.deepEqual(reader.reads.sort(), ['acme/web#1', 'acme/web#2']);
  assert.deepEqual(
    store.pullsOf('bob').map((stored) => stored.snapshot?.head),
    ['a1', 'a2'],
  );
});

test('a burst of webhooks on one pull request gives one read after the debounce', async () => {
  const { store, reader, tracker, reads } = setup(20);
  reader.results.set('acme', [pr(1)]);
  reader.heads.set('acme/web#1', 'a1');
  store.setConfig('alice', { org: 'acme', settings: settings() }, 0);
  await tracker.refreshUser('alice');
  reader.reads.length = 0;
  reads.length = 0;
  reader.heads.set('acme/web#1', 'a2');
  for (let index = 0; index < 5; index++) tracker.onChange({ type: 'check_run', repo: 'acme/web', number: 1 });
  assert.deepEqual(reader.reads, []);
  await wait(60);
  await tracker.idle();
  assert.deepEqual(reader.reads, ['acme/web#1']);
  assert.deepEqual(reads, ['acme/web#1']);
  assert.equal(store.pull(pr(1))?.snapshot?.head, 'a2');
  tracker.stop();
});

test('a status webhook reads the pull request of its head commit, and a change of an unknown pull request reads nothing', async () => {
  const { store, reader, tracker } = setup();
  reader.results.set('acme', [pr(1)]);
  reader.heads.set('acme/web#1', 'a1');
  store.setConfig('alice', { org: 'acme', settings: settings() }, 0);
  await tracker.refreshUser('alice');
  reader.reads.length = 0;
  tracker.onChange({ type: 'status', repo: 'acme/web', sha: 'a1' });
  tracker.onChange({ type: 'status', repo: 'acme/web', sha: 'other' });
  tracker.onChange({ type: 'check_run', repo: 'acme/web', number: 99 });
  await wait(30);
  await tracker.idle();
  assert.deepEqual(reader.reads, ['acme/web#1']);
  tracker.stop();
});

test('an opened pull request makes the lists read again', async () => {
  const { store, reader, tracker } = setup();
  store.setConfig('alice', { org: 'acme', settings: settings() }, 0);
  await tracker.refreshUser('alice');
  reader.results.set('acme', [pr(1), pr(3)]);
  reader.heads.set('acme/web#1', 'a1');
  reader.heads.set('acme/web#3', 'a3');
  tracker.onChange({ type: 'pull_request', action: 'opened', repo: 'acme/web', number: 3 });
  await wait(30);
  await tracker.idle();
  assert.deepEqual(
    store.pullsOf('alice').map((stored) => stored.pr.number),
    [1, 3],
  );
  tracker.stop();
});

test('a read that fails is kept with its error, and the next read works again', async () => {
  const { store, reader, tracker } = setup();
  reader.results.set('acme', [pr(1)]);
  store.setConfig('alice', { org: 'acme', settings: settings() }, 0);
  await tracker.refreshUser('alice');
  assert.match(store.pull(pr(1))?.error ?? '', /502/);
  reader.heads.set('acme/web#1', 'a1');
  tracker.onChange({ type: 'pull_request', action: 'synchronize', repo: 'acme/web', number: 1 });
  await wait(30);
  await tracker.idle();
  assert.equal(store.pull(pr(1))?.error, undefined);
  assert.equal(store.pull(pr(1))?.snapshot?.head, 'a1');
});

test('a user with no config follows nothing', async () => {
  const { reader, tracker } = setup();
  await tracker.refreshUser('nobody');
  assert.deepEqual(reader.searches, []);
});

test('the reader searches and reads with the token of the installation of the owner', async () => {
  const calls: { url: string; authorization: string; body?: string }[] = [];
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      url: input,
      authorization: headers.authorization ?? '',
      ...(typeof init.body === 'string' && { body: init.body }),
    });
    if (input.includes('/search/issues'))
      return Response.json({
        items: [
          {
            number: 7,
            title: 'Seven',
            html_url: 'https://github.com/acme/web/pull/7',
            repository_url: 'https://api.github.com/repos/acme/web',
          },
        ],
      });
    if (input.endsWith('/graphql') && JSON.parse(String(init.body)).variables.number === 8)
      return Response.json({ errors: [{ message: 'Could not resolve' }] });
    if (input.endsWith('/graphql')) return Response.json({ data: { ok: true } });
    return new Response('', { status: 500 });
  }) as typeof fetch;
  const reader = pullReader(
    {
      installations: async () => new Map([['acme', 1]]),
      tokenFor: async (owner) => (owner === 'acme' ? 'ghs_acme' : undefined),
    },
    { fetch: fetchFn, apiUrl: 'https://api.test' },
  );
  assert.deepEqual(await reader.search('acme', 'is:pr author:alice'), [
    { repo: 'acme/web', number: 7, title: 'Seven', url: 'https://github.com/acme/web/pull/7' },
  ]);
  assert.equal(
    calls[0]?.url,
    'https://api.test/search/issues?q=is%3Apr%20author%3Aalice&sort=updated&per_page=100&page=1',
  );
  assert.equal(calls[0]?.authorization, 'Bearer ghs_acme');
  assert.deepEqual(await reader.graphql('acme')('query', { number: 7 }), { ok: true });
  await assert.rejects(reader.graphql('acme')('query', { number: 8 }), /GitHub GraphQL: Could not resolve/);
  await assert.rejects(reader.search('other', 'x'), /not installed on other/);
});
