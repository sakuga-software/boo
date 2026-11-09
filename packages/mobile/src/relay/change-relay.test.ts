import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import { relayChanger } from './change-relay';
import type { RelayState } from './state';

const connection = { url: 'https://a.test', session: 'sess', login: 'alice' };
const DEFAULT = 'https://boo-relay.sakuga.dev';

function setup(initial: RelayState, probe: (url: string) => Promise<string | undefined> = async () => undefined) {
  let state = initial;
  const log: string[] = [];
  const change = relayChanger(
    {
      probe: async (url) => {
        log.push(`probe ${url}`);
        return probe(url);
      },
      current: () => state,
      markSigningOut: () => void log.push('signing out'),
      endSession: async (ended: RelayConnection) => void log.push(`end ${ended.url} ${ended.session}`),
      store: async (url) => void log.push(`store ${url ?? 'default'}`),
    },
    DEFAULT,
  );
  return { change, log, set: (next: RelayState) => void (state = next) };
}

test('a change signs out of the current relay, then keeps the new one', async () => {
  const { change, log } = setup({ status: 'signedIn', connection });
  assert.deepEqual(await change('https://b.test'), { relayUrl: 'https://b.test' });
  assert.deepEqual(log, ['probe https://b.test', 'signing out', 'end https://a.test sess', 'store https://b.test']);
});

test('back to the default relay forgets the choice; signed out, nothing is ended', async () => {
  const { change, log } = setup({ status: 'signedOut' });
  assert.deepEqual(await change(undefined), { relayUrl: DEFAULT });
  assert.deepEqual(log, [`probe ${DEFAULT}`, 'store default']);
});

test('a relay that fails the probe changes nothing', async () => {
  const { change, log } = setup({ status: 'signedIn', connection }, async (url) => `${url} is not a boo relay.`);
  assert.deepEqual(await change('https://b.test'), { problem: 'https://b.test is not a boo relay.' });
  assert.deepEqual(log, ['probe https://b.test']);
});

test('a session that ends during the probe is not signed out again (#96fd77)', async () => {
  let release!: () => void;
  const { change, log, set } = setup(
    { status: 'signedIn', connection },
    () => new Promise((resolve) => (release = () => resolve(undefined))),
  );
  const running = change('https://b.test');
  // The person signs out, or the relay ends the session, while the probe waits.
  set({ status: 'signedOut' });
  release();
  assert.deepEqual(await running, { relayUrl: 'https://b.test' });
  assert.deepEqual(log, ['probe https://b.test', 'store https://b.test']);
});

test('a sign-out that runs at the end of the probe makes the change wait, and a second tap is refused', async () => {
  let release!: () => void;
  const { change, log, set } = setup(
    { status: 'signedIn', connection },
    () => new Promise((resolve) => (release = () => resolve(undefined))),
  );
  const running = change('https://b.test');
  assert.deepEqual(await change('https://c.test'), { problem: 'The relay is already changing.' });
  set({ status: 'signedIn', connection, signingOut: true });
  release();
  assert.deepEqual(await running, { problem: 'Wait for the sign-out to end.' });
  assert.deepEqual(log, ['probe https://b.test']);
  // The guard is free again.
  set({ status: 'signedOut' });
  const again = change('https://c.test');
  release();
  assert.deepEqual(await again, { relayUrl: 'https://c.test' });
});

test('no change during the sign-in, and a store that fails still gives the new relay', async () => {
  const signingIn = setup({ status: 'signingIn', step: { step: 'starting' } });
  assert.deepEqual(await signingIn.change('https://b.test'), { problem: 'Wait for the sign-in to end.' });
  assert.deepEqual(signingIn.log, []);
  const change = relayChanger(
    {
      probe: async () => undefined,
      current: () => ({ status: 'signedOut' }),
      markSigningOut: () => {},
      endSession: async () => {},
      store: async () => {
        throw new Error('keychain locked');
      },
    },
    DEFAULT,
  );
  assert.deepEqual(await change('https://b.test'), { relayUrl: 'https://b.test' });
});
