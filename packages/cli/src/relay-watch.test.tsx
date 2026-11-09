import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { render } from 'ink-testing-library';
import { App, type GitHub } from './app.js';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { RelayChange, RelayHandlers, RelaySource } from '@sakuga-software/boo-core/stream';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const pr = (number: number): PullRequest => ({
  repo: 'acme/web',
  number,
  title: `feat: change ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
});

const snapshot = (head: string, patch: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  status: 'open',
  head,
  branch: `feat-${head}`,
  fork: false,
  base: 'main',
  defaultBranch: 'main',
  author: 'me',
  mergeState: 'clean',
  reviews: [{ user: { login: 'alice' }, commit_id: head, submitted_at: ago(5), state: 'APPROVED' }],
  comments: [],
  checks: [{ name: 'test', state: 'success' }],
  requested: [],
  headAt: ago(1),
  ...patch,
});

/** A fake GitHub that counts the reads of each pull request and of the list. */
function countingGitHub(listed: number[], patchOf: (number: number) => Partial<PullRequestSnapshot> = () => ({})) {
  const reads = new Map<number, number>();
  const ages: number[] = [];
  let lists = 0;
  const gitHub: GitHub = {
    listPullRequests: async () => {
      lists++;
      return listed.map(pr);
    },
    fetchPullRequest: async (target, options) => {
      reads.set(target.number, (reads.get(target.number) ?? 0) + 1);
      if (options?.maxAgeMs !== undefined) ages.push(options.maxAgeMs);
      return snapshot(`head${target.number}`, patchOf(target.number));
    },
    requestReview: async () => 'https://github.com/acme/web/pull/1#comment',
    openInBrowser: async () => {},
    mergePullRequest: async () => {},
  };
  return { gitHub, reads, ages, lists: () => lists, readsOf: (number: number) => reads.get(number) ?? 0 };
}

/** A fake relay: the test calls its handlers. */
function fakeRelay() {
  let handlers: RelayHandlers | undefined;
  const source: RelaySource = { subscribe: (given) => void (handlers = given) };
  const ready = async () => {
    const end = Date.now() + 2_000;
    while (!handlers && Date.now() < end) await sleep(5);
    assert.ok(handlers, 'the app did not subscribe');
    return handlers;
  };
  return { source, ready };
}

const change = (patch: Partial<RelayChange>): RelayChange => ({
  type: 'check_run',
  repo: 'acme/web',
  at: new Date().toISOString(),
  ...patch,
});

function start(t: TestContext, gitHub: GitHub, relay?: RelaySource, timing: Record<string, number> = {}) {
  const app = render(
    <App
      options={{ org: 'acme', authors: ['@me'], watch: true, dryRun: false, interactive: true }}
      gitHub={gitHub}
      sessions={{ readOwners: async () => new Map(), send: async () => {} }}
      settings={DEFAULT_SETTINGS}
      saveSettings={async () => {}}
      relay={relay}
      timing={{ relaySettleMs: 30, relayPollMs: 60 * 60_000, relayMergeDelayMs: 50, ...timing }}
    />,
  );
  t.after(() => app.unmount());
  return app;
}

async function until(check: () => boolean, what: string, timeoutMs = 2_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !check()) await sleep(10);
  assert.ok(check(), `No ${what}`);
}

test('with a live relay, a change reads only its pull request, once for a burst, and the header says live', async (t) => {
  const github = countingGitHub([1, 2]);
  const relay = fakeRelay();
  const app = start(t, github.gitHub, relay.source);
  const handlers = await relay.ready();
  await until(() => github.readsOf(1) >= 1 && github.readsOf(2) >= 1, 'first reads');
  handlers.state('live');
  await until(() => (app.lastFrame() ?? '').includes('live · safety check in'), 'live header');
  const before = { one: github.readsOf(1), two: github.readsOf(2) };

  for (let index = 0; index < 10; index++) handlers.change(change({ number: 1 }));
  await until(() => github.readsOf(1) > before.one, 'read of the changed pull request');
  await sleep(150);
  assert.equal(github.readsOf(1), before.one + 1);
  assert.equal(github.readsOf(2), before.two);
});

test('a change that gives only a commit reads the pull request with that head', async (t) => {
  const github = countingGitHub([1, 2]);
  const relay = fakeRelay();
  start(t, github.gitHub, relay.source);
  const handlers = await relay.ready();
  await until(() => github.readsOf(2) >= 1, 'first reads');
  handlers.state('live');
  const before = github.readsOf(2);
  handlers.change(change({ type: 'status', sha: 'head2' }));
  await until(() => github.readsOf(2) > before, 'read of the pull request of the commit');
});

test('an opened pull request reads the list again, and a reset reads every pull request', async (t) => {
  const listed = [1];
  const github = countingGitHub(listed);
  const relay = fakeRelay();
  const app = start(t, github.gitHub, relay.source);
  const handlers = await relay.ready();
  await until(() => github.readsOf(1) >= 1, 'first read');
  handlers.state('live');
  listed.push(2);
  const lists = github.lists();
  handlers.change(change({ type: 'pull_request', action: 'opened', number: 2 }));
  await until(() => github.lists() > lists, 'list read');
  await until(() => (app.lastFrame() ?? '').includes('#2'), 'new row');

  const before = { one: github.readsOf(1), two: github.readsOf(2) };
  handlers.reset();
  await until(() => github.readsOf(1) > before.one && github.readsOf(2) > before.two, 'reads of every row');
});

test('a change dated in the past lets a read of another run after it answer, so runs share the cache', async (t) => {
  const github = countingGitHub([1]);
  const relay = fakeRelay();
  start(t, github.gitHub, relay.source);
  const handlers = await relay.ready();
  await until(() => github.readsOf(1) >= 1, 'first read');
  handlers.state('live');
  const count = github.ages.length;
  handlers.change(change({ number: 1, at: new Date(Date.now() - 5_000).toISOString() }));
  await until(() => github.ages.length > count, 'read after the change');
  const age = github.ages.at(-1)!;
  assert.ok(age >= 5_000 && age < 10_000, `maxAgeMs ${age}`);
});

test('a relay that is down says poll, and an expired session says to run the setup again', async (t) => {
  const github = countingGitHub([1]);
  const relay = fakeRelay();
  const app = start(t, github.gitHub, relay.source);
  const handlers = await relay.ready();
  handlers.state('poll', 'ECONNRESET');
  await until(() => (app.lastFrame() ?? '').includes('poll · next check in'), 'poll header');
  handlers.state('expired', 'the relay no longer knows the session: run boo setup-webhooks again');
  await until(() => (app.lastFrame() ?? '').includes('relay session ended: run boo setup-webhooks'), 'expired notice');
});

test('without a relay, the header shows no relay state', async (t) => {
  const github = countingGitHub([1]);
  const app = start(t, github.gitHub);
  await until(() => (app.lastFrame() ?? '').includes('next check in'), 'next check');
  assert.doesNotMatch(app.lastFrame() ?? '', /live ·|poll ·/);
});

test('a merge reads the other pull requests on the same base after a delay, and no other', async (t) => {
  const github = countingGitHub([1, 2, 3], (number) => (number === 3 ? { base: 'release' } : {}));
  const relay = fakeRelay();
  start(t, github.gitHub, relay.source);
  const handlers = await relay.ready();
  await until(() => [1, 2, 3].every((number) => github.readsOf(number) >= 1), 'first reads');
  handlers.state('live');
  await sleep(50);
  const before = { two: github.readsOf(2), three: github.readsOf(3) };
  handlers.change(
    change({
      type: 'pull_request',
      action: 'closed',
      number: 9,
      data: { pullRequest: { merged: true, baseRef: 'main' } },
    }),
  );
  await until(() => github.readsOf(2) > before.two, 'read of the pull request on the same base');
  await sleep(100);
  assert.equal(github.readsOf(3), before.three);
});

test('a closed pull request that did not merge reads no other pull request', async (t) => {
  const github = countingGitHub([1, 2]);
  const relay = fakeRelay();
  start(t, github.gitHub, relay.source);
  const handlers = await relay.ready();
  await until(() => github.readsOf(2) >= 1, 'first reads');
  handlers.state('live');
  await sleep(50);
  const before = github.readsOf(2);
  handlers.change(
    change({ type: 'pull_request', action: 'closed', number: 9, data: { pullRequest: { merged: false } } }),
  );
  await sleep(200);
  assert.equal(github.readsOf(2), before);
});

test('while live, a pull request whose mergeable state is unknown is read again until GitHub gives it', async (t) => {
  let settled = false;
  const github = countingGitHub([1, 2], (number) => (number === 1 && !settled ? { mergeState: 'unknown' } : {}));
  const relay = fakeRelay();
  start(t, github.gitHub, relay.source, { watchPollMs: 80 });
  const handlers = await relay.ready();
  await until(() => github.readsOf(1) >= 1, 'first read');
  handlers.state('live');
  const before = { one: github.readsOf(1), two: github.readsOf(2) };
  await until(() => github.readsOf(1) >= before.one + 2, 'reads while unknown', 3_000);
  assert.equal(github.readsOf(2), before.two);
  settled = true;
  await until(() => github.readsOf(1) >= before.one + 3, 'read that settles', 3_000);
  const after = github.readsOf(1);
  await sleep(300);
  assert.equal(github.readsOf(1), after);
});
