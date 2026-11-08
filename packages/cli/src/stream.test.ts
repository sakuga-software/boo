import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { parseSse, relayStream, type RelayChange, type RelayState } from './stream.js';

const connection = { url: 'https://relay.test', session: 'sess', login: 'alice' };

test('the parser cuts events, keeps the rest, joins data lines and skips comments', () => {
  const { events, rest } = parseSse(': ping\n\nid: b-1\nevent: change\ndata: {"a":\ndata: 1}\n\nevent: rea');
  assert.deepEqual(events, [{ id: 'b-1', event: 'change', data: '{"a":\n1}' }]);
  assert.equal(rest, 'event: rea');
  assert.deepEqual(parseSse('event: ready\r\ndata: {}\r\n\r\n').events, [{ event: 'ready', data: '{}' }]);
});

/** A fake relay: each call of fetch takes the next script, sends its chunks, then ends or stays open. */
function fakeRelay(t: TestContext, scripts: ({ status?: number; chunks: string[]; hold?: boolean } | Error)[]) {
  const calls: { headers: Record<string, string> }[] = [];
  const fetchFn = (async (_input: string, init: RequestInit = {}) => {
    calls.push({ headers: init.headers as Record<string, string> });
    const script = scripts.shift() ?? { chunks: [], hold: true };
    if (script instanceof Error) throw script;
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
  const abort = new AbortController();
  t.after(() => abort.abort());
  const changes: RelayChange[] = [];
  const states: [RelayState, string | undefined][] = [];
  let resets = 0;
  const sleeps: number[] = [];
  const source = relayStream(connection, {
    fetch: fetchFn,
    sleep: async (ms) => void sleeps.push(ms),
    idleMs: 50,
  });
  source.subscribe(
    {
      change: (change) => void changes.push(change),
      reset: () => void resets++,
      state: (state, detail) => void states.push([state, detail]),
    },
    abort.signal,
  );
  const until = async (check: () => boolean, what: string) => {
    const end = Date.now() + 2_000;
    while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check(), `No ${what}. States: ${JSON.stringify(states)}`);
  };
  return { calls, changes, states, sleeps, resets: () => resets, until, abort };
}

const change = (id: string, number: number) =>
  `id: ${id}\nevent: change\ndata: ${JSON.stringify({ type: 'pull_request', repo: 'acme/web', number, at: 't' })}\n\n`;

test('the stream says live on ready, gives each change, even split across chunks, and sends the session', async (t) => {
  const relay = fakeRelay(t, [
    {
      chunks: [
        'event: ready\ndata: {}\n\n',
        change('b-1', 1).slice(0, 20),
        change('b-1', 1).slice(20) + change('b-2', 2),
      ],
      hold: true,
    },
  ]);
  await relay.until(() => relay.changes.length === 2, 'two changes');
  assert.deepEqual(relay.states[0], ['live', undefined]);
  assert.deepEqual(
    relay.changes.map((item) => item.number),
    [1, 2],
  );
  assert.equal(relay.calls[0]!.headers.authorization, 'Bearer sess');
});

test('after a cut, the stream reconnects with the last event id, and waits longer each time', async (t) => {
  const relay = fakeRelay(t, [
    { chunks: ['event: ready\ndata: {}\n\n', change('b-7', 7)] },
    new Error('ECONNRESET'),
    { chunks: ['event: ready\ndata: {}\n\nevent: reset\ndata: {}\n\n'], hold: true },
  ]);
  await relay.until(() => relay.resets() === 1, 'reset');
  assert.equal(relay.calls[1]!.headers['last-event-id'], 'b-7');
  assert.equal(relay.calls[2]!.headers['last-event-id'], 'b-7');
  assert.ok(relay.states.some(([state]) => state === 'poll'));
  assert.deepEqual(relay.sleeps.slice(0, 2), [1_000, 2_000]);
  assert.deepEqual(relay.states.at(-1), ['live', undefined]);
});

test('a stream with no byte for its idle time counts as cut, and opens again', async (t) => {
  const relay = fakeRelay(t, [
    { chunks: ['event: ready\ndata: {}\n\n'], hold: true },
    { chunks: ['event: ready\ndata: {}\n\n'], hold: true },
  ]);
  await relay.until(() => relay.calls.length >= 2, 'second connection');
  assert.ok(relay.states.some(([state, detail]) => state === 'poll' && /no byte/.test(detail ?? '')));
});

test('a session that the relay refuses or ends stops the stream, with the setup command to run', async (t) => {
  const refused = fakeRelay(t, [{ status: 401, chunks: [] }]);
  await refused.until(() => refused.states.some(([state]) => state === 'expired'), 'expired state');
  assert.match(refused.states.at(-1)![1]!, /run boo setup-webhooks again/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(refused.calls.length, 1);

  const ended = fakeRelay(t, [
    {
      chunks: ['event: ready\ndata: {}\n\nevent: expired\ndata: {"message":"The session was deleted"}\n\n'],
      hold: true,
    },
  ]);
  await ended.until(() => ended.states.some(([state]) => state === 'expired'), 'expired state');
  assert.match(ended.states.at(-1)![1]!, /The session was deleted: run boo setup-webhooks again/);
});

test('a relay that answers an error status, or closes the stream, gets a reconnect', async (t) => {
  const relay = fakeRelay(t, [
    { status: 502, chunks: [] },
    { chunks: [] },
    { chunks: ['event: ready\ndata: {}\n\n'], hold: true },
  ]);
  await relay.until(() => relay.states.at(-1)?.[0] === 'live', 'live state');
  assert.ok(relay.states.some(([, detail]) => /answered 502/.test(detail ?? '')));
  assert.ok(relay.states.some(([, detail]) => /closed the stream/.test(detail ?? '')));
});
