import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RelayState } from '@sakuga-software/boo-core/stream';
import { liveBadge } from './list';
import { startLive } from './live';

const connection = { url: 'https://relay.test', session: 'sess', login: 'alice' };

/** A fake relay: each connection takes the next script, sends its chunks, then ends or stays open. */
function relay(scripts: { status?: number; chunks: string[]; hold?: boolean }[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const script = scripts.shift() ?? { chunks: [], hold: true };
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of script.chunks) controller.enqueue(encoder.encode(chunk));
        if (!script.hold) controller.close();
        init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
      },
    });
    return new Response(body, { status: script.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const until = async (check: () => boolean, what: string) => {
  const end = Date.now() + 2_000;
  while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `No ${what}`);
};

test('the stream opens from the cursor of the list, and a burst of changes gives one read', async (t) => {
  const { calls, fetchFn } = relay([
    {
      chunks: [
        'event: ready\ndata: {"login":"alice","cursor":"b-3"}\n\n',
        'id: b-4\nevent: head\ndata: {}\n\n',
        'id: b-5\nevent: check\ndata: {}\n\n',
        ': ping\n\n',
      ],
      hold: true,
    },
  ]);
  const states: RelayState[] = [];
  let reads = 0;
  const stop = startLive({
    connection,
    fetch: fetchFn,
    cursor: 'b-3',
    read: () => void reads++,
    onState: (state) => void states.push(state),
    settleMs: 20,
  });
  t.after(stop);
  await until(() => reads === 1, 'read');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reads, 1);
  assert.deepEqual(states, ['live']);
  assert.equal(calls[0]!.url, 'https://relay.test/state/events');
  assert.equal(calls[0]!.headers['last-event-id'], 'b-3');
  assert.equal(calls[0]!.headers.authorization, 'Bearer sess');
});

test('a reset reads the list at once, and a stream with no cursor sends no last event id', async (t) => {
  const { calls, fetchFn } = relay([
    { chunks: ['event: ready\ndata: {}\n\nevent: reset\ndata: {"cursor":"c-1"}\n\n'], hold: true },
  ]);
  let reads = 0;
  const stop = startLive({
    connection,
    fetch: fetchFn,
    cursor: undefined,
    read: () => void reads++,
    onState: () => {},
  });
  t.after(stop);
  await until(() => reads === 1, 'read');
  assert.equal(calls[0]!.headers['last-event-id'], undefined);
});

test('a relay that refuses the session says expired; stop closes the stream and cancels a read to come', async () => {
  const refused = relay([{ status: 401, chunks: [] }]);
  const states: RelayState[] = [];
  const stopRefused = startLive({
    connection,
    fetch: refused.fetchFn,
    cursor: 'b-1',
    read: () => {},
    onState: (state) => void states.push(state),
  });
  await until(() => states.includes('expired'), 'expired');
  stopRefused();

  const open = relay([{ chunks: ['event: ready\ndata: {}\n\nid: b-2\nevent: head\ndata: {}\n\n'], hold: true }]);
  let reads = 0;
  const live: RelayState[] = [];
  const stop = startLive({
    connection,
    fetch: open.fetchFn,
    cursor: 'b-1',
    read: () => void reads++,
    onState: (state) => void live.push(state),
    settleMs: 30,
  });
  await until(() => live.includes('live'), 'live');
  stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reads, 0);
  assert.equal(open.calls.length, 1);
});

test('a stream that is cut says poll, and opens again from the last id after a wait', async (t) => {
  const { calls, fetchFn } = relay([
    { chunks: ['event: ready\ndata: {}\n\nid: b-7\nevent: head\ndata: {}\n\n'] },
    { chunks: ['event: ready\ndata: {}\n\n'], hold: true },
  ]);
  const states: RelayState[] = [];
  const stop = startLive({
    connection,
    fetch: fetchFn,
    cursor: 'b-6',
    read: () => {},
    onState: (state) => void states.push(state),
  });
  t.after(stop);
  // The reader of core waits 1 s before the first reconnect.
  await until(() => calls.length === 2, 'reconnect');
  assert.equal(calls[1]!.headers['last-event-id'], 'b-7');
  assert.deepEqual(states.slice(0, 2), ['live', 'poll']);
});

test('the badge says live or poll, as the header of the terminal', () => {
  assert.equal(liveBadge(undefined), undefined);
  assert.deepEqual(liveBadge('live')?.text, 'live');
  assert.deepEqual(liveBadge('live')?.tone, 'green');
  assert.deepEqual(
    (['poll', 'expired'] as const).map((state) => liveBadge(state)?.text),
    ['poll', 'poll'],
  );
});
