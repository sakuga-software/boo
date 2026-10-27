import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { render } from 'ink-testing-library';
import { App, type GitHub } from './app.js';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import type { LocalSession, Owner } from './sessions.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const pr = (number: number, title = `feat: change ${number}`): PullRequest => ({
  repo: 'acme/web',
  number,
  title,
  url: `https://github.com/acme/web/pull/${number}`,
});

const snapshot = (patch: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  status: 'open',
  head: 'abc123',
  branch: 'feat-a',
  fork: false,
  base: 'main',
  defaultBranch: 'main',
  author: 'me',
  mergeState: 'clean',
  reviews: [],
  comments: [],
  checks: [],
  requested: [],
  headAt: ago(1),
  ...patch,
});

const approved = (patch: Partial<PullRequestSnapshot> = {}) =>
  snapshot({
    reviews: [{ user: { login: 'alice' }, commit_id: 'abc123', submitted_at: ago(5), state: 'APPROVED' }],
    checks: [{ name: 'test', state: 'success' }],
    ...patch,
  });

interface Fake {
  gitHub: GitHub;
  merges: { pr: PullRequest; head: string }[];
}

function fakeGitHub(snapshots: Map<number, PullRequestSnapshot | Error>, extra: Partial<GitHub> = {}): Fake {
  const merges: Fake['merges'] = [];
  const gitHub: GitHub = {
    listPullRequests: async () => [...snapshots.keys()].map((number) => pr(number)),
    fetchPullRequest: async (target) => {
      const found = snapshots.get(target.number);
      if (!found || found instanceof Error) throw found ?? new Error('not found');
      return found;
    },
    requestReview: async () => 'https://github.com/acme/web/pull/1#comment',
    openInBrowser: async () => {},
    mergePullRequest: async (target, head) => {
      merges.push({ pr: target, head });
      snapshots.set(target.number, snapshot({ status: 'merged' }));
    },
    ...extra,
  };
  return { gitHub, merges };
}

function start(
  gitHub: GitHub,
  settings: Settings = DEFAULT_SETTINGS,
  owners = new Map<string, Owner>(),
  repos?: string[],
) {
  return render(
    <App
      options={{
        org: 'acme',
        authors: ['@me'],
        ...(repos && { repos }),
        watch: true,
        dryRun: false,
        interactive: true,
      }}
      gitHub={gitHub}
      sessions={{ readOwners: async () => owners, send: async () => {} }}
      settings={settings}
      saveSettings={async () => {}}
    />,
  );
}

type Rendered = ReturnType<typeof start>;

async function frameWith(app: Rendered, text: string, timeoutMs = 2_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const frame = app.lastFrame() ?? '';
    if (frame.includes(text)) return frame;
    await sleep(10);
  }
  assert.fail(`No frame shows "${text}". The last frame:\n${app.lastFrame()}`);
}

async function press(app: Rendered, ...keys: string[]) {
  for (const key of keys) {
    app.stdin.write(key);
    await sleep(20);
  }
}

test('each pull request takes one row with its state, and the footer counts the states', async (t) => {
  const { gitHub } = fakeGitHub(
    new Map([
      [1, snapshot({ checks: [{ name: 'test', state: 'failure' }] })],
      [2, approved()],
    ]),
  );
  const app = start(gitHub);
  t.after(() => app.unmount());
  const frame = await frameWith(app, 'ready to merge');
  assert.match(frame, /checks failing\s+web#1\s+feat: change 1/);
  assert.match(frame, /ready to merge\s+web#2\s+feat: change 2/);
  assert.match(frame, /1 ready to merge · 1 checks failing/);
});

test('e unfolds the selected row with its failing checks, and e again folds it', async (t) => {
  const { gitHub } = fakeGitHub(new Map([[1, snapshot({ checks: [{ name: 'Migrations', state: 'failure' }] })]]));
  const app = start(gitHub);
  t.after(() => app.unmount());
  await frameWith(app, 'checks failing');
  await press(app, 'e');
  await frameWith(app, '✖ Migrations');
  await press(app, 'e');
  await sleep(50);
  assert.doesNotMatch(app.lastFrame() ?? '', /Migrations/);
});

test('m asks before a merge, n cancels it, and y merges the head that the question showed', async (t) => {
  const { gitHub, merges } = fakeGitHub(new Map([[1, approved()]]));
  const app = start(gitHub);
  t.after(() => app.unmount());
  await frameWith(app, 'ready to merge');

  await press(app, 'm');
  await frameWith(app, 'Merge acme/web#1?');
  await press(app, 'n');
  await sleep(50);
  assert.doesNotMatch(app.lastFrame() ?? '', /Merge acme\/web#1\?/);
  assert.deepEqual(merges, []);

  await press(app, 'm');
  await frameWith(app, 'Merge acme/web#1?');
  await press(app, 'y');
  await frameWith(app, 'Merged acme/web#1.');
  assert.deepEqual(
    merges.map(({ pr: { number }, head }) => ({ number, head })),
    [{ number: 1, head: 'abc123' }],
  );
});

test('a pull request that misses the merge policy is approved, not ready, and m refuses to merge it', async (t) => {
  const { gitHub, merges } = fakeGitHub(new Map([[1, approved({ body: 'No recording.' })]]));
  const app = start(gitHub, { ...DEFAULT_SETTINGS, mergePolicy: { requireProof: '\\.gif' } });
  t.after(() => app.unmount());
  const frame = await frameWith(app, 'approved');
  assert.doesNotMatch(frame, /ready to merge/);
  await press(app, 'm');
  await frameWith(app, 'Cannot merge acme/web#1, it misses the merge policy: no proof.');
  assert.deepEqual(merges, []);
});

test('a red pull request with no session and an old head commit is stalled', async (t) => {
  const { gitHub } = fakeGitHub(
    new Map([[1, snapshot({ headAt: ago(120), checks: [{ name: 'test', state: 'failure' }] })]]),
  );
  const app = start(gitHub);
  t.after(() => app.unmount());
  await frameWith(app, 'zZ');
  await press(app, 'e');
  await frameWith(app, 'stalled: no session works on it');
});

test('an unfolded merged pull request says who merged it', async (t) => {
  const { gitHub } = fakeGitHub(new Map([[1, snapshot({ status: 'merged', mergedBy: 'octocat', mergedAt: ago(3) })]]));
  const app = start(gitHub, { ...DEFAULT_SETTINGS, hideMerged: false });
  t.after(() => app.unmount());
  await frameWith(app, 'merged');
  await press(app, 'e');
  await frameWith(app, 'by octocat · 3 min ago');
});

test('a pull request that GitHub moved after its parent merged asks for a rebase', async (t) => {
  const { gitHub } = fakeGitHub(new Map([[1, approved({ restack: { oldBase: 'feat-0', at: ago(5) } })]]));
  const app = start(gitHub);
  t.after(() => app.unmount());
  await frameWith(app, 'parent merged · rebase');
  await press(app, 'e');
  await frameWith(app, 'rebase on main: its parent on feat-0 merged');
});

test('a pull request that GitHub does not answer keeps its row, with the error, and the footer counts it', async (t) => {
  const { gitHub } = fakeGitHub(new Map([[1, new Error('HTTP 502')]]));
  const app = start(gitHub);
  t.after(() => app.unmount());
  const frame = await frameWith(app, '1 error');
  assert.doesNotMatch(frame, /Nothing to show/);
  await press(app, 'e');
  await frameWith(app, 'HTTP 502');
});

test('a read that fails after a good read counts as an error, not as its old state', async (t) => {
  const snapshots = new Map<number, PullRequestSnapshot | Error>([[1, approved()]]);
  const { gitHub } = fakeGitHub(snapshots);
  const app = start(gitHub);
  t.after(() => app.unmount());
  await frameWith(app, '1 ready to merge');
  snapshots.set(1, new Error('HTTP 502'));
  await press(app, 'r');
  const frame = await frameWith(app, '1 error');
  assert.doesNotMatch(frame, /1 ready to merge/);
});

test('the header and the empty list name the watched repositories, and the search gets them', async (t) => {
  const searches: (string[] | undefined)[] = [];
  const { gitHub } = fakeGitHub(new Map(), {
    listPullRequests: async ({ repos }) => {
      searches.push(repos);
      return [];
    },
  });
  const app = start(gitHub, DEFAULT_SETTINGS, new Map(), ['acme/web', 'other/api']);
  t.after(() => app.unmount());
  const frame = await frameWith(app, 'No open pull request by @me in acme/web, other/api.');
  assert.match(frame, /@me · acme\/web, other\/api/);
  assert.deepEqual(searches[0], ['acme/web', 'other/api']);
});

test('low GraphQL points slow the refresh down, and the header says so', async (t) => {
  const { gitHub } = fakeGitHub(new Map([[1, approved()]]), {
    readRateLimit: async () => ({ limit: 5_000, remaining: 100, resetAt: new Date(now + 3_600_000).toISOString() }),
  });
  const app = start(gitHub);
  t.after(() => app.unmount());
  await frameWith(app, 'GraphQL 100/5000 left, refresh every 5 min');
});

test('a read that GitHub refuses for a rate limit keeps the last state of the row, and the header says until when', async (t) => {
  const until = new Date(now + 30 * 60_000).toISOString();
  const { gitHub } = fakeGitHub(new Map([[1, approved({ stale: { at: ago(10), until } })]]), {
    readRateLimit: async () => ({ limit: 5_000, remaining: 0, resetAt: until }),
  });
  const app = start(gitHub);
  t.after(() => app.unmount());
  const frame = await frameWith(app, '1 stale');
  assert.match(frame, /GitHub refuses the GraphQL queries until/);
  assert.match(frame, /ready to merge/);
  assert.doesNotMatch(frame, /error/);
});

test('a merge whose next read GitHub refuses says that the new status could not be read', async (t) => {
  const snapshots = new Map<number, PullRequestSnapshot | Error>([[1, approved()]]);
  const { gitHub } = fakeGitHub(snapshots, {
    mergePullRequest: async () => {
      snapshots.set(1, approved({ stale: { at: ago(0), until: new Date(now + 60_000).toISOString() } }));
    },
  });
  const app = start(gitHub);
  t.after(() => app.unmount());
  await frameWith(app, 'ready to merge');
  await press(app, 'm');
  await frameWith(app, 'Merge acme/web#1?');
  await press(app, 'y');
  await frameWith(app, 'GitHub accepted the merge of acme/web#1');
});

test('m refuses to merge a stale pull request: its approval can be old', async (t) => {
  const until = new Date(now + 30 * 60_000).toISOString();
  const { gitHub, merges } = fakeGitHub(new Map([[1, approved({ stale: { at: ago(10), until } })]]), {
    readRateLimit: async () => ({ limit: 5_000, remaining: 0, resetAt: until }),
  });
  const app = start(gitHub);
  t.after(() => app.unmount());
  await frameWith(app, '1 stale');
  await press(app, 'm');
  await frameWith(app, 'Cannot merge acme/web#1: its state is from');
  assert.doesNotMatch(app.lastFrame() ?? '', /Merge acme\/web#1\?/);
  assert.deepEqual(merges, []);
});

test('two pull requests of two sub-agents of one session show the two sub-agents', async (t) => {
  const { gitHub } = fakeGitHub(
    new Map([
      [1, snapshot()],
      [2, snapshot()],
    ]),
  );
  const session: LocalSession = {
    pid: 1,
    sessionId: 's1',
    name: 'orchestra',
    status: 'idle',
    cwd: '/work',
    socket: '/tmp/s.sock',
  };
  const linkedAt = new Date(now);
  const app = start(
    gitHub,
    DEFAULT_SETTINGS,
    new Map([
      [
        'acme/web#1',
        { session, linkedAt, subAgent: { id: 'a1', description: 'Fix the search filter of the list', state: 'done' } },
      ],
      ['acme/web#2', { session, linkedAt, subAgent: { id: 'a2', state: 'failed', error: 'rate limit' } }],
    ]),
  );
  t.after(() => app.unmount());
  const frame = await frameWith(app, 'orchestra › a2');
  assert.match(frame, /web#1 .*orchestra › Fix the search filter o…/);
  assert.match(frame, /web#2 .*orchestra › a2 ✖/);
  await press(app, 'e');
  await frameWith(app, 'session orchestra › sub-agent Fix the search');
  await frameWith(app, '/work · session idle');
  await press(app, 'e', '\u001B[B', 'e');
  await frameWith(app, 'session orchestra › sub-agent a2 · failed: rat');
});
