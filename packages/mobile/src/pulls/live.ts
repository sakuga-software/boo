import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import { relayStream, type RelayState } from '@sakuga-software/boo-core/stream';

export interface LiveDeps {
  connection: RelayConnection;
  fetch: typeof fetch;
  /** The cursor of the last `GET /state`: the relay sends the changes after it, or a reset. */
  cursor: string | undefined;
  /** Reads `GET /state` again. */
  read: () => void;
  /** `live`: the stream is open. `poll`: it is down and opens again. `expired`: the relay refused the session. */
  onState: (state: RelayState) => void;
  /** The events of a burst give one read: the read waits this time after the last one. */
  settleMs?: number;
}

const SETTLE_MS = 300;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Keeps the list live with `/state/events`, through the reader of core. An event of the stream says
 * that the reports changed: the list reads `GET /state` again, once for a burst. A reset reads it at
 * once. The reader of core opens the stream again after a cut, with the last cursor. Returns `stop`.
 */
export function startLive({ connection, fetch, cursor, read, onState, settleMs = SETTLE_MS }: LiveDeps): () => void {
  const stopped = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    clearTimeout(timer);
    timer = setTimeout(read, settleMs);
  };
  relayStream(
    connection,
    { fetch, sleep },
    { path: '/state/events', ...(cursor && { lastEventId: cursor }) },
  ).subscribe(
    {
      // `/state/events` sends no `change`: that is the event of the webhooks, on `/events`.
      change: () => {},
      event: (event) => {
        if (event.id) settle();
      },
      reset: () => {
        clearTimeout(timer);
        read();
      },
      state: (state) => onState(state),
    },
    stopped.signal,
  );
  return () => {
    clearTimeout(timer);
    stopped.abort();
  };
}
