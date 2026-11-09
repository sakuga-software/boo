import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSignIn, type SignInDeps, type SignInStep } from './sign-in';

type Answer = { status?: number; body: unknown };

const RELAY = 'https://relay.test';
const INSTALL = 'https://github.com/apps/boo-relay/installations/new';
const none: Answer = { body: { installations: [], installUrl: INSTALL } };
const installed: Answer = { body: { installations: [{ id: 1, account: 'acme' }], installUrl: INSTALL } };
const pending: Answer = { body: { error: 'authorization_pending' } };
const granted: Answer = { body: { access_token: 'ghu_x' } };

/** A fake relay and GitHub: each route answers from its queue, and the last answer repeats. */
function network(token: Answer[], installations: Answer[] = [installed], github = 'https://github.com') {
  const routes: Record<string, Answer[]> = {
    [`GET ${RELAY}`]: [{ body: { name: 'boo-relay', clientId: 'Iv1.app', installUrl: INSTALL } }],
    [`POST ${github}/login/device/code`]: [
      {
        body: {
          device_code: 'dc',
          user_code: 'ABCD-1234',
          verification_uri: `${github}/login/device`,
          expires_in: 900,
          interval: 5,
        },
      },
    ],
    [`POST ${github}/login/oauth/access_token`]: token,
    [`POST ${RELAY}/sessions`]: [{ status: 201, body: { session: 'sess', login: 'alice' } }],
    [`GET ${RELAY}/installations`]: installations,
    [`DELETE ${RELAY}/sessions`]: [{ status: 204, body: null }],
  };
  const calls: string[] = [];
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${input}`;
    calls.push(key);
    const queue = routes[key];
    if (!queue) throw new Error(`no route for ${key}`);
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    return new Response(answer.body === null ? null : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** Timers that run only when the test says so, and a clock that they move. */
function timers() {
  let clock = 0;
  const due: { at: number; run: () => void }[] = [];
  return {
    now: () => clock,
    setTimeout: (run: () => void, ms: number) => {
      const timer = { at: clock + ms, run };
      due.push(timer);
      return timer;
    },
    clearTimeout: (timer: unknown) => {
      const index = due.indexOf(timer as (typeof due)[number]);
      if (index >= 0) due.splice(index, 1);
    },
    /** Runs the next timer, after the calls of the network that come before it. */
    async tick() {
      await settle();
      const next = due.sort((a, b) => a.at - b.at).shift();
      if (!next) return false;
      clock = next.at;
      next.run();
      await settle();
      return true;
    },
    pending: () => due.length,
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(fetchFn: typeof fetch, extra: Partial<SignInDeps> = {}) {
  const steps: SignInStep[] = [];
  const opened: string[] = [];
  const copied: string[] = [];
  const clock = timers();
  const signIn = startSignIn({
    relayUrl: RELAY,
    fetch: fetchFn,
    openBrowser: (url) => void opened.push(url),
    copy: async (text) => void copied.push(text),
    onStep: (step) => void steps.push(step),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...extra,
  });
  return { signIn, steps, opened, copied, clock };
}

test('the screen shows the code; the button copies it and opens GitHub; the poll gives the connection', async () => {
  const { fetchFn, calls } = network([pending, granted]);
  const { signIn, steps, opened, copied, clock } = setup(fetchFn);
  await settle();
  assert.deepEqual(steps.at(-1), {
    step: 'code',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    opened: false,
  });
  // Core calls `open` for the GitHub page: the screen opens nothing until the person taps.
  assert.deepEqual(opened, []);
  await signIn.openGitHub();
  assert.deepEqual(copied, ['ABCD-1234']);
  assert.deepEqual(opened, ['https://github.com/login/device']);
  assert.equal((steps.at(-1) as { opened: boolean }).opened, true);
  while (await clock.tick());
  assert.deepEqual(await signIn.done, { url: RELAY, session: 'sess', login: 'alice' });
  assert.equal(calls.filter((call) => call.endsWith('/access_token')).length, 2);
});

test('with no installation, the screen shows the install step, and its button opens the install page', async () => {
  const { fetchFn } = network([granted], [none, none, installed]);
  const { signIn, steps, opened, clock } = setup(fetchFn);
  await clock.tick();
  assert.deepEqual(steps.at(-1), { step: 'install', installUrl: INSTALL });
  // Core opens the install page by itself: the screen waits for a tap.
  assert.deepEqual(opened, []);
  signIn.openInstall();
  assert.deepEqual(opened, [INSTALL]);
  while (await clock.tick());
  assert.deepEqual(await signIn.done, { url: RELAY, session: 'sess', login: 'alice' });
});

test('later ends the wait for an installation at once, and keeps the session', async () => {
  const { fetchFn, calls } = network([granted], [none]);
  const { signIn, clock } = setup(fetchFn);
  await clock.tick();
  assert.equal(clock.pending(), 1);
  signIn.later();
  assert.deepEqual(await signIn.done, { url: RELAY, session: 'sess', login: 'alice' });
  assert.ok(!calls.includes(`DELETE ${RELAY}/sessions`));
});

test('a cancel during the code step stops the poll, and no session is opened', async () => {
  const { fetchFn, calls } = network([pending]);
  const { signIn, clock } = setup(fetchFn);
  await settle();
  signIn.cancel();
  assert.equal(await signIn.done, undefined);
  await clock.tick();
  assert.ok(!calls.some((call) => call.includes('/sessions')));
  // The buttons of a step that is gone do nothing.
  await signIn.openGitHub();
  signIn.openInstall();
});

test('a cancel after the relay opened the session deletes it', async () => {
  const { fetchFn, calls } = network([granted], [none]);
  const { signIn, clock } = setup(fetchFn);
  await clock.tick();
  signIn.cancel();
  assert.equal(await signIn.done, undefined);
  assert.ok(calls.includes(`DELETE ${RELAY}/sessions`));
});

test('a cancel during the call that brings the token still deletes the session that follows', async () => {
  const { fetchFn, calls } = network([granted], [installed]);
  let signIn: ReturnType<typeof startSignIn> | undefined;
  const cancelling = (async (input: string, init?: RequestInit) => {
    if (input.endsWith('/access_token')) signIn!.cancel();
    return fetchFn(input, init);
  }) as typeof fetch;
  const run = setup(cancelling);
  signIn = run.signIn;
  await run.clock.tick();
  assert.equal(await signIn.done, undefined);
  assert.ok(calls.includes(`POST ${RELAY}/sessions`));
  assert.ok(calls.includes(`DELETE ${RELAY}/sessions`));
});

test('a refused sign-in shows the error of core, and the done promise fails', async () => {
  const { fetchFn } = network([{ body: { error: 'access_denied' } }]);
  const { signIn, steps, clock } = setup(fetchFn);
  const failed = assert.rejects(signIn.done, /denied/);
  await clock.tick();
  await failed;
  assert.deepEqual(steps.at(-1), { step: 'failed', message: 'The authorization was denied on GitHub.' });
});

test('another GitHub gets the device flow, and a clipboard that fails still opens the page', async () => {
  const fake = 'http://localhost:4610';
  const { fetchFn, calls } = network([granted], [installed], fake);
  const { signIn, opened, clock } = setup(fetchFn, {
    githubUrl: fake,
    copy: async () => {
      throw new Error('no clipboard');
    },
  });
  await settle();
  await signIn.openGitHub();
  assert.deepEqual(opened, [`${fake}/login/device`]);
  while (await clock.tick());
  await signIn.done;
  assert.ok(calls.includes(`POST ${fake}/login/device/code`));
});

test('a failed read of the installations during the install step keeps the wait, and later still gives the session', async () => {
  const { fetchFn, calls } = network([granted], [none]);
  let reads = 0;
  const flaky = (async (input: string, init?: RequestInit) => {
    if (input === `${RELAY}/installations` && ++reads > 1) {
      if (reads === 2) throw new Error('offline');
      return new Response(JSON.stringify({ error: 'boom' }), { status: 502 });
    }
    return fetchFn(input, init);
  }) as typeof fetch;
  const { signIn, steps, clock } = setup(flaky);
  await clock.tick();
  await clock.tick();
  await clock.tick();
  assert.equal(reads, 3);
  assert.deepEqual(steps.at(-1), { step: 'install', installUrl: INSTALL });
  signIn.later();
  assert.deepEqual(await signIn.done, { url: RELAY, session: 'sess', login: 'alice' });
  assert.ok(!calls.includes(`DELETE ${RELAY}/sessions`));
});

test('a failed read of the installations before the install step still fails the sign-in', async () => {
  const { fetchFn } = network([granted]);
  const failing = (async (input: string, init?: RequestInit) => {
    if (input === `${RELAY}/installations`) throw new Error('offline');
    return fetchFn(input, init);
  }) as typeof fetch;
  const { signIn, steps, clock } = setup(failing);
  const failed = assert.rejects(signIn.done, /offline/);
  await clock.tick();
  await failed;
  assert.equal(steps.at(-1)!.step, 'failed');
});
