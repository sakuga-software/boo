import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hub, type RelayEvent, type Subscriber } from './hub.js';

const change = (repo: string, number: number) => ({ type: 'pull_request', repo, number });

function listener(repos: string[]): Subscriber & { got: RelayEvent[] } {
  const got: RelayEvent[] = [];
  return { got, reads: (repo) => repos.includes(repo), send: (event) => got.push(event) };
}

test('a subscriber gets the events of the repositories that it reads, and no other', () => {
  const hub = new Hub();
  const alice = listener(['acme/web']);
  hub.subscribe(alice);
  hub.publish(change('acme/web', 1));
  hub.publish(change('acme/secret', 2));
  assert.deepEqual(
    alice.got.map((event) => event.number),
    [1],
  );
  hub.unsubscribe(alice);
  hub.publish(change('acme/web', 3));
  assert.equal(alice.got.length, 1);
  assert.equal(hub.size, 0);
});

test('a subscriber that resumes gets the events after its last one that it can read', () => {
  const hub = new Hub();
  const first = hub.publish(change('acme/web', 1));
  hub.publish(change('acme/secret', 2));
  hub.publish(change('acme/web', 3));
  const resumed = hub.subscribe(listener(['acme/web']), first.id);
  assert.notEqual(resumed, 'reset');
  assert.deepEqual(resumed !== 'reset' && resumed.missed.map((event) => event.number), [3]);
  const last = hub.publish(change('acme/web', 4));
  const upToDate = hub.subscribe(listener(['acme/web']), last.id);
  assert.deepEqual(upToDate, { missed: [] });
});

test('a resume from another boot, an unknown id or a dropped event asks for a reset', () => {
  const hub = new Hub(2);
  const first = hub.publish(change('acme/web', 1));
  hub.publish(change('acme/web', 2));
  hub.publish(change('acme/web', 3));
  const subscriber = listener(['acme/web']);
  assert.equal(hub.subscribe(subscriber, 'other-1'), 'reset');
  assert.equal(hub.subscribe(subscriber, first.id.replace(/-\d+$/, '-99')), 'reset');
  assert.equal(hub.subscribe(subscriber, first.id.replace(/-\d+$/, '-x')), 'reset');
  // The hub keeps events 2 and 3: after event 1 it misses nothing, before it the events are gone.
  assert.notEqual(hub.subscribe(subscriber, first.id), 'reset');
  assert.equal(hub.subscribe(subscriber, first.id.replace(/-\d+$/, '-0')), 'reset');
});

test('a subscriber that fails does not stop the delivery to the others', (t) => {
  const hub = new Hub();
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  hub.subscribe({
    reads: () => true,
    send: () => {
      throw new Error('write after end');
    },
  });
  const other = listener(['acme/web']);
  hub.subscribe(other);
  assert.doesNotThrow(() => hub.publish(change('acme/web', 1)));
  assert.equal(other.got.length, 1);
});

test('the hub drops its oldest events past its size in bytes, and a resume before them gets a reset', () => {
  const hub = new Hub(10_000, () => new Date(0), 1_000);
  const big = (number: number) => ({ ...change('acme/web', number), data: { comment: { body: 'x'.repeat(400) } } });
  const first = hub.publish(big(1));
  hub.publish(big(2));
  hub.publish(big(3));
  assert.equal(hub.subscribe(listener(['acme/web']), first.id), 'reset');
  const second = hub.publish(big(4));
  const resumed = hub.subscribe(listener(['acme/web']), second.id);
  assert.deepEqual(resumed, { missed: [] });
});
