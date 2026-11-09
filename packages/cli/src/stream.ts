import type { RelayConnection } from './webhooks.js';

/** A change that the relay sends: the pull request that changed, or the head commit if GitHub gave no number. */
export interface RelayChange {
  type: string;
  action?: string;
  repo: string;
  number?: number;
  sha?: string;
  /** The time that the relay received the webhook. */
  at: string;
  /** The fields of the webhook. The watch reads only these ones. */
  data?: { pullRequest?: { merged?: boolean; baseRef?: string } };
}

/** `live`: the stream is open. `poll`: it is down and reconnects. `expired`: the session ended, no reconnect. */
export type RelayState = 'live' | 'poll' | 'expired';

export interface RelayHandlers {
  change(change: RelayChange): void;
  /** The relay cannot give the events that the watch missed: the watch must read all. */
  reset(): void;
  state(state: RelayState, detail?: string): void;
}

/** A source of relay changes. The app takes one in its props, so that the tests give a fake. */
export interface RelaySource {
  subscribe(handlers: RelayHandlers, signal: AbortSignal): void;
}

export interface StreamDeps {
  fetch: typeof fetch;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The relay sends a ping every 25 s. With no byte for this time, the connection is dead. */
  idleMs?: number;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
const IDLE_MS = 90_000;

interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

/** Cuts a text of server-sent events into events. Returns the events and the rest that is not complete yet. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const blocks = buffer.replaceAll('\r\n', '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const event: SseEvent = { event: 'message', data: '' };
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event.event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') event.id = value;
    }
    event.data = data.join('\n');
    if (data.length > 0 || event.event !== 'message') events.push(event);
  }
  return { events, rest };
}

class SessionExpired extends Error {}

/** Reads the event stream of a relay, and opens it again after a cut, with the last event id. */
export function relayStream(connection: RelayConnection, deps: StreamDeps): RelaySource {
  const idleMs = deps.idleMs ?? IDLE_MS;
  return {
    subscribe(handlers, signal) {
      let lastId: string | undefined;
      let retry = FIRST_RETRY_MS;

      async function readOnce(): Promise<void> {
        const idle = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => idle.abort(new Error('no byte from the relay')), idleMs);
        };
        touch();
        try {
          const response = await deps.fetch(`${connection.url}/events`, {
            redirect: 'error',
            headers: {
              authorization: `Bearer ${connection.session}`,
              accept: 'text/event-stream',
              ...(lastId && { 'last-event-id': lastId }),
            },
            signal: AbortSignal.any([signal, idle.signal]),
          });
          if (response.status === 401) throw new SessionExpired('the relay no longer knows the session');
          if (!response.ok || !response.body) throw new Error(`the relay answered ${response.status}`);
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
            touch();
            buffer += decoder.decode(chunk, { stream: true });
            const { events, rest } = parseSse(buffer);
            buffer = rest;
            for (const event of events) {
              if (event.event === 'ready') {
                retry = FIRST_RETRY_MS;
                handlers.state('live');
              } else if (event.event === 'change') {
                if (event.id) lastId = event.id;
                handlers.change(JSON.parse(event.data) as RelayChange);
              } else if (event.event === 'reset') handlers.reset();
              else if (event.event === 'expired') {
                const { message } = JSON.parse(event.data || '{}') as { message?: string };
                throw new SessionExpired(message ?? 'the session ended');
              }
            }
          }
          throw new Error('the relay closed the stream');
        } finally {
          clearTimeout(timer);
        }
      }

      void (async () => {
        while (!signal.aborted) {
          try {
            await readOnce();
          } catch (error) {
            if (signal.aborted) return;
            if (error instanceof SessionExpired) {
              handlers.state('expired', `${error.message}: run boo setup-webhooks again`);
              return;
            }
            handlers.state('poll', error instanceof Error ? error.message : String(error));
          }
          await deps.sleep(retry, signal).catch(() => {});
          retry = Math.min(retry * 2, MAX_RETRY_MS);
        }
      })();
    },
  };
}
