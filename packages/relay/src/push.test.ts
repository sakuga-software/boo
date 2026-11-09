import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PullRequestSnapshot } from '@sakuga-software/boo-core/github';
import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { DEFAULT_SETTINGS, type Settings } from '@sakuga-software/boo-core/settings';
import { SessionExpired } from './access.js';
import {
  CHUNK_SIZE,
  expoPush,
  messagesOf,
  pullUrl,
  pushOf,
  PushNotifier,
  type ExpoMessage,
  type ExpoPush,
  type SendResult,
} from './push.js';
import { Reports } from './reports.js';
import type { Session } from './sessions.js';
import { StateStore } from './state-store.js';

const MINUTE = 60_000;
const start = Date.parse('2026-11-09T12:00:00Z');
const TOKEN = 'ExponentPushToken[alice-phone]';
const OTHER = 'ExponentPushToken[alice-tablet]';

const pr = (number: number, repo = 'acme/web') => ({
  repo,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
});
const red = [{ name: 'ci', state: 'failure' as const }];
const green = [{ name: 'ci', state: 'success' as const }];
const snapshot = (patch: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  status: 'open',
  head: 'a1',
  branch: 'feature',
  fork: false,
  base: 'main',
  defaultBranch: 'main',
  author: 'alice',
  mergeState: 'clean',
  reviews: [],
  comments: [],
  checks: green,
  requested: [],
  headAt: new Date(start).toISOString(),
  ...patch,
});

const session = (id: string): Session => ({
  id,
  user: { id: 1, login: 'Alice' },
  tokens: { accessToken: 'ghu_alice' },
  createdAt: new Date(start).toISOString(),
});

/** A fake Expo push service: it records the messages, and answers with the tickets that `answer` gives. */
function fakeExpo(
  answer: (message: ExpoMessage) => { status: 'ok' | 'error'; error?: string } = () => ({ status: 'ok' }),
) {
  const sent: ExpoMessage[] = [];
  const receiptReads: string[][] = [];
  let receiptOf: (id: string) => string | undefined = () => undefined;
  const expo: ExpoPush = {
    send: async (messages): Promise<SendResult> => {
      const result: SendResult = { accepted: 0, unregistered: [], tickets: new Map(), errors: [] };
      for (const message of messages) {
        sent.push(message);
        const { status, error } = answer(message);
        if (status === 'ok') {
          result.accepted++;
          result.tickets.set(`ticket-${sent.length}`, message.to);
        } else {
          if (error === 'DeviceNotRegistered') result.unregistered.push(message.to);
          result.errors.push(`Expo refused a phone: ${error}`);
        }
      }
      return result;
    },
    receipts: async (tickets) => {
      receiptReads.push([...tickets.keys()]);
      return {
        unregistered: [...tickets].filter(([id]) => receiptOf(id) === 'DeviceNotRegistered').map(([, token]) => token),
        errors: [],
      };
    },
  };
  return { expo, sent, receiptReads, setReceipts: (fn: typeof receiptOf) => void (receiptOf = fn) };
}

function setup({
  settings = {},
  repos = ['acme/web'],
  store = new StateStore(':memory:'),
  answer,
}: {
  settings?: Partial<Settings>;
  repos?: string[];
  store?: StateStore;
  answer?: Parameters<typeof fakeExpo>[0];
} = {}) {
  let clock = start;
  store.setConfig('alice', { org: 'acme', settings: { ...DEFAULT_SETTINGS, ...settings } }, clock);
  const reports = new Reports(store, () => clock);
  const sessions = new Map([['s1', session('s1')]]);
  const access = {
    failure: undefined as Error | undefined,
    repos: new Set(repos),
    /** Runs during the read of the access, as a request of the phone would. */
    during: undefined as (() => void) | undefined,
  };
  const fake = fakeExpo(answer);
  const logs: string[] = [];
  const errors: unknown[] = [];
  const notifier = new PushNotifier({
    store,
    reports,
    sessions: { get: (id) => sessions.get(id) },
    access: {
      repos: async () => {
        await Promise.resolve();
        access.during?.();
        if (access.failure) throw access.failure;
        return access.repos;
      },
    },
    expo: fake.expo,
    windowMs: 60_000,
    receiptsAfterMs: 10,
    log: (message) => logs.push(message),
    error: (error) => errors.push(error),
  });
  store.setDevice(TOKEN, { session: 's1', login: 'alice' }, clock);
  const read = (number: number, patch: Partial<PullRequestSnapshot> = {}) => {
    store.savePull(pr(number), { snapshot: snapshot(patch) }, clock);
    reports.refresh('alice');
  };
  const follow = (...numbers: number[]) => {
    for (const number of numbers) store.savePull(pr(number), { snapshot: snapshot() }, clock);
    store.setFollows(
      'alice',
      numbers.map((number) => pr(number)),
      clock,
    );
  };
  const flush = async () => {
    await notifier.flush('alice');
    await notifier.idle();
  };
  return {
    store,
    reports,
    sessions,
    access,
    notifier,
    ...fake,
    logs,
    errors,
    read,
    follow,
    flush,
    advance: (ms: number) => void (clock += ms),
  };
}

test('a pull request whose checks fail gives one push to each phone of the user, with the screen to open', async () => {
  const { reports, read, follow, flush, sent, store } = setup();
  store.setDevice(OTHER, { session: 's2', login: 'alice' }, start);
  follow(1);
  assert.equal(reports.get('alice').reports[0]?.state, 'awaiting review');
  read(1, { checks: red });
  assert.equal(sent.length, 0, 'the window holds the change');
  await flush();
  // s2 is not a session of this relay: its phone gets nothing, and its token is dropped.
  assert.deepEqual(sent, [
    {
      to: TOKEN,
      title: 'Checks failing: acme/web#1',
      body: 'PR 1\nFailing: ci',
      sound: 'default',
      data: { url: 'boo://pull/acme/web/1', pr: 'acme/web#1', state: 'checksFailing' },
    },
  ]);
  assert.deepEqual(
    store.devicesOf('alice').map(({ token }) => token),
    [TOKEN],
  );
});

test('the changes of a window go out once, with the last state; a pull request back to its state gives nothing', async () => {
  const { reports, read, follow, flush, sent } = setup();
  follow(1, 2);
  reports.get('alice');
  read(1, { checks: red });
  read(1, { checks: green });
  read(2, { mergeState: 'dirty' });
  read(2, { mergeState: 'dirty', checks: red });
  read(2, { mergeState: 'dirty' });
  await flush();
  assert.deepEqual(
    sent.map(({ title }) => title),
    ['Conflicts: acme/web#2'],
  );
  // A second flush has nothing to send.
  await flush();
  assert.equal(sent.length, 1);
});

test('a state that the settings turn off gives no push, and the others still do', async () => {
  const { reports, read, follow, flush, sent } = setup({ settings: { push: { checksFailing: false } } });
  follow(1, 2);
  reports.get('alice');
  read(1, { checks: red });
  read(2, { mergeState: 'dirty' });
  await flush();
  assert.deepEqual(
    sent.map(({ title }) => title),
    ['Conflicts: acme/web#2'],
  );
});

test('a merge gives a push with who merged it', async () => {
  const { reports, read, follow, flush, sent } = setup();
  follow(1);
  reports.get('alice');
  read(1, { status: 'merged', mergedBy: 'bob', mergedAt: new Date(start).toISOString() });
  await flush();
  assert.deepEqual(
    sent.map(({ title, body }) => ({ title, body })),
    [{ title: 'Merged: acme/web#1', body: 'PR 1\nMerged by bob' }],
  );
});

test('a pull request that stalls gives a push with no webhook, from the timer of the reports', async () => {
  const { reports, read, follow, flush, sent, advance } = setup();
  follow(1);
  reports.get('alice');
  read(1, { checks: red });
  await flush();
  advance(31 * MINUTE);
  reports.refreshAll();
  await flush();
  assert.deepEqual(
    sent.map(({ title }) => title),
    ['Checks failing: acme/web#1', 'Stalled: acme/web#1'],
  );
});

test('a pull request that enters the list gives no push, whatever its state', async () => {
  const { reports, store, read, flush, sent } = setup();
  reports.get('alice');
  store.savePull(pr(5), { snapshot: snapshot({ mergeState: 'dirty' }) }, start);
  store.setFollows('alice', [pr(5)], start);
  reports.refresh('alice');
  await flush();
  assert.equal(sent.length, 0);
  read(5, { mergeState: 'clean', checks: red });
  await flush();
  assert.deepEqual(
    sent.map(({ title }) => title),
    ['Checks failing: acme/web#5'],
  );
});

test('more than three changes in a window give one push that counts them', async () => {
  const { reports, read, follow, flush, sent } = setup();
  follow(1, 2, 3, 4, 5, 6, 7);
  reports.get('alice');
  for (const number of [1, 2, 3, 4, 5, 6, 7]) read(number, { checks: red });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, '7 pull requests changed');
  assert.equal(sent[0]?.body, [1, 2, 3, 4, 5].map((n) => `Checks failing: acme/web#${n}`).join('\n') + '\nand 2 more');
  assert.deepEqual(sent[0]?.data, { url: 'boo://' });
});

test('a phone gets only the pull requests that its session reads', async () => {
  const { reports, read, follow, flush, sent, access } = setup({ repos: ['acme/other'] });
  follow(1);
  reports.get('alice');
  read(1, { checks: red });
  await flush();
  assert.equal(sent.length, 0);
  access.repos = new Set(['acme/web']);
  read(1, { checks: green });
  read(1, { mergeState: 'dirty' });
  await flush();
  assert.equal(sent.length, 1);
});

test('a failed read of the access sends nothing; an expired session loses its phone', async () => {
  const { reports, read, follow, flush, sent, access, errors, store } = setup();
  follow(1);
  reports.get('alice');
  access.failure = new Error('GitHub is down');
  read(1, { checks: red });
  await flush();
  assert.equal(sent.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(store.devicesOf('alice').length, 1);
  access.failure = new SessionExpired('expired');
  read(1, { mergeState: 'dirty' });
  await flush();
  assert.equal(sent.length, 0);
  assert.equal(store.devicesOf('alice').length, 0);
});

test('a token that Expo does not know any more, in a ticket or in a receipt, is dropped', async () => {
  const { reports, read, follow, flush, store, sessions, setReceipts, receiptReads, notifier, logs, sent } = setup({
    answer: (message) => (message.to === OTHER ? { status: 'error', error: 'DeviceNotRegistered' } : { status: 'ok' }),
  });
  sessions.set('s2', session('s2'));
  store.setDevice(OTHER, { session: 's2', login: 'alice' }, start);
  setReceipts(() => 'DeviceNotRegistered');
  follow(1, 2);
  reports.get('alice');
  read(1, { checks: red });
  read(2, { checks: red });
  await flush();
  assert.deepEqual(sent.map(({ to }) => to).sort(), [OTHER, OTHER, TOKEN, TOKEN].sort());
  assert.deepEqual(
    store.devicesOf('alice').map(({ token }) => token),
    [TOKEN],
  );
  // The receipts are read after `receiptsAfterMs`, for the tickets that Expo accepted.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await notifier.idle();
  assert.equal(receiptReads.length, 1);
  assert.equal(receiptReads[0]?.length, 2, 'only the tickets that Expo accepted');
  assert.equal(store.devicesOf('alice').length, 0);
  assert.equal(logs.filter((line) => line.startsWith('Push: removed 1 tokens')).length, 2);
});

test('a restart sends nothing twice, and sends once a change of the time of the stop', async () => {
  const store = new StateStore(':memory:');
  const first = setup({ store });
  first.follow(1);
  first.reports.get('alice');
  first.read(1, { checks: red });
  await first.flush();
  assert.equal(first.sent.length, 1);
  // A change that waits in the window when the relay stops is not lost.
  first.read(1, { mergeState: 'dirty', checks: red });
  first.notifier.stop();

  const second = setup({ store });
  second.reports.get('alice');
  await second.flush();
  assert.deepEqual(
    second.sent.map(({ title }) => title),
    ['Conflicts: acme/web#1'],
  );
  second.notifier.stop();

  // The same reports after one more restart give nothing.
  const third = setup({ store });
  third.reports.get('alice');
  await third.flush();
  assert.equal(third.sent.length, 0);
  third.notifier.stop();

  // A change of the time of the stop.
  store.savePull(pr(1), { snapshot: snapshot({ status: 'merged', mergedBy: 'bob' }) }, start);
  const fourth = setup({ store });
  fourth.reports.get('alice');
  await fourth.flush();
  assert.deepEqual(
    fourth.sent.map(({ title }) => title),
    ['Merged: acme/web#1'],
  );
});

test('a push that fails does not stop the computation of the reports', () => {
  const { reports, store, errors, follow } = setup();
  follow(1);
  reports.get('alice');
  store.setPushMark = () => {
    throw new Error('disk full');
  };
  // A pull request that enters the list writes its mark at once.
  follow(1, 2);
  assert.equal(reports.refresh('alice').reports.length, 2);
  assert.deepEqual(
    errors.map((error) => (error as Error).message),
    ['disk full'],
  );
});

test('pushOf gives the new state, or stalled, or nothing', () => {
  assert.equal(pushOf({ state: 'reviewing', stalled: false }, { state: 'ready to merge', stalled: false }), 'ready');
  assert.equal(
    pushOf({ state: 'reviewing', stalled: false }, { state: 'changes requested', stalled: false }),
    'changesRequested',
  );
  assert.equal(
    pushOf({ state: 'checks failing', stalled: false }, { state: 'checks failing', stalled: true }),
    'stalled',
  );
  assert.equal(
    pushOf({ state: 'checks failing', stalled: true }, { state: 'checks failing', stalled: true }),
    undefined,
  );
  assert.equal(pushOf({ state: 'checks failing', stalled: true }, { state: 'reviewing', stalled: false }), undefined);
  assert.equal(
    pushOf({ state: 'conflicts', stalled: false }, { state: 'checks failing', stalled: true }),
    'checksFailing',
  );
});

test('a message cuts a long title, and the link encodes the names', () => {
  const report = { repo: 'acme/web app', number: 3, title: 'x'.repeat(300), checks: { failing: [] }, mergedBy: null };
  const [message] = messagesOf([{ report: report as unknown as PullRequestReport, push: 'ready' }], TOKEN);
  assert.equal(message?.body.length, 180);
  assert.ok(message?.body.endsWith('…'));
  assert.equal(message?.data.url, 'boo://pull/acme/web%20app/3');
  assert.equal(pullUrl({ repo: 'a/b', number: 1 }), 'boo://pull/a/b/1');
});

/** A fake Expo push service over `fetch`: no request leaves the process. */
function fakeFetch(answers: ((body: unknown) => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  const request = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as unknown;
    calls.push({ url: String(url), init, body });
    const answer = answers.shift();
    if (!answer) throw new Error('no answer');
    return answer(body);
  }) as typeof fetch;
  return { request, calls };
}

const message = (index: number): ExpoMessage => ({
  to: `ExponentPushToken[${index}]`,
  title: 't',
  body: 'b',
  sound: 'default',
  data: { url: 'boo://' },
});

test('expoPush sends in chunks of 100, and goes on after a chunk that fails', async () => {
  const tickets = (body: unknown) =>
    Response.json({
      data: (body as ExpoMessage[]).map((sent) => {
        if (sent.to === 'ExponentPushToken[7]')
          return { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } };
        if (sent.to === 'ExponentPushToken[8]')
          return { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } };
        return { status: 'ok', id: `id-${sent.to}` };
      }),
    });
  const { request, calls } = fakeFetch([
    tickets,
    () => new Response('busy', { status: 503 }),
    () => {
      throw new Error('socket hang up');
    },
    tickets,
  ]);
  const expo = expoPush({ url: 'https://expo.test/', accessToken: 'secret', fetch: request });
  const messages = Array.from({ length: 3 * CHUNK_SIZE + 2 }, (_, index) => message(index));
  const result = await expo.send(messages);
  assert.deepEqual(
    calls.map(({ url, body }) => [url, (body as unknown[]).length]),
    [
      ['https://expo.test/--/api/v2/push/send', 100],
      ['https://expo.test/--/api/v2/push/send', 100],
      ['https://expo.test/--/api/v2/push/send', 100],
      ['https://expo.test/--/api/v2/push/send', 2],
    ],
  );
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer secret');
  assert.equal(calls[0]?.init.redirect, 'error');
  assert.equal(result.accepted, 98 + 2);
  assert.deepEqual(result.unregistered, ['ExponentPushToken[7]']);
  assert.equal(result.tickets.size, 98 + 2);
  assert.equal(result.tickets.get('id-ExponentPushToken[301]'), 'ExponentPushToken[301]');
  assert.deepEqual(result.errors, [
    'Expo refused a phone: DeviceNotRegistered',
    'Expo refused a phone: MessageTooBig',
    'Expo answered 503',
    'Expo failed: socket hang up',
  ]);
});

test('expoPush reads the receipts and gives the tokens that are not registered', async () => {
  const { request, calls } = fakeFetch([
    () =>
      Response.json({
        data: {
          a: { status: 'ok' },
          b: { status: 'error', details: { error: 'DeviceNotRegistered' } },
          c: { status: 'error', details: { error: 'MessageRateExceeded' } },
          unknown: { status: 'error', details: { error: 'DeviceNotRegistered' } },
        },
      }),
  ]);
  const expo = expoPush({ url: 'https://expo.test', fetch: request });
  const tickets = new Map([
    ['a', 'ExponentPushToken[a]'],
    ['b', 'ExponentPushToken[b]'],
    ['c', 'ExponentPushToken[c]'],
  ]);
  assert.deepEqual(await expo.receipts(tickets), { unregistered: ['ExponentPushToken[b]'], errors: [] });
  assert.equal(calls[0]?.url, 'https://expo.test/--/api/v2/push/getReceipts');
  assert.deepEqual(calls[0]?.body, { ids: ['a', 'b', 'c'] });
  assert.equal('authorization' in ((calls[0]?.init.headers ?? {}) as object), false);

  const failing = expoPush({
    url: 'https://expo.test',
    fetch: fakeFetch([() => new Response('', { status: 500 }), () => Promise.reject(new Error('offline'))]).request,
  });
  assert.deepEqual(await failing.receipts(tickets), { unregistered: [], errors: ['Expo answered 500'] });
  assert.deepEqual(await failing.receipts(tickets), { unregistered: [], errors: ['Expo failed: offline'] });
});

test('a phone that signs out, or signs in as another user, during the read of the access gets nothing', async () => {
  const { reports, read, follow, flush, sent, access, store, sessions } = setup();
  follow(1);
  reports.get('alice');
  // The phone of alice signs in as bob while the relay reads the access of alice.
  access.during = () => store.setDevice(TOKEN, { session: 'bob-1', login: 'bob' }, start);
  read(1, { checks: red });
  await flush();
  assert.equal(sent.length, 0);
  // The phone of alice signs out while the relay reads the access.
  store.setDevice(TOKEN, { session: 's1', login: 'alice' }, start);
  access.during = () => {
    sessions.delete('s1');
    store.removeSessionDevices('s1');
  };
  read(1, { mergeState: 'dirty', checks: red });
  await flush();
  assert.equal(sent.length, 0);
});

test('a pull request that leaves the list during the window gives nothing', async () => {
  const { reports, store, read, follow, flush, sent, notifier } = setup();
  follow(1, 2);
  reports.get('alice');
  read(1, { checks: red });
  // New settings: alice no longer follows #1.
  store.setFollows('alice', [pr(2)], start);
  reports.refresh('alice');
  await flush();
  assert.equal(sent.length, 0);
  // The window of alice is closed: no timer waits.
  await notifier.flush('alice');
  assert.equal(sent.length, 0);
});

test('a pull request that enters the list again starts from its state then, not from its old mark', async () => {
  const { reports, store, read, follow, flush, sent } = setup();
  follow(1, 2);
  reports.get('alice');
  read(1, { mergeState: 'dirty' });
  await flush();
  assert.deepEqual(
    sent.map(({ title }) => title),
    ['Conflicts: acme/web#1'],
  );
  // #1 leaves the list, its checks fail meanwhile, and it comes back.
  store.setFollows('alice', [pr(2)], start);
  reports.refresh('alice');
  store.savePull(pr(1), { snapshot: snapshot({ checks: red }) }, start);
  follow(1, 2);
  store.savePull(pr(1), { snapshot: snapshot({ checks: red }) }, start);
  reports.refresh('alice');
  await flush();
  assert.equal(sent.length, 1, 'entering the list again is not a change');
  // Back to conflicts: a change from the state of the entry.
  read(1, { mergeState: 'dirty' });
  await flush();
  assert.deepEqual(
    sent.map(({ title }) => title),
    ['Conflicts: acme/web#1', 'Conflicts: acme/web#1'],
  );
});
