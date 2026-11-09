import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import type { RelayState } from '@sakuga-software/boo-core/stream';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { afterRead, FIRST_READ, startRead, type PullsState } from './list';
import { startLive } from './live';
import { readState } from './read-state';

const SESSION_REFUSED = { status: 'failed', message: 'The relay refused the session.' } as const;
/** With no open stream, the app reads the list at this interval, in the foreground. */
const POLL_MS = 60_000;

/** True when the app is on the screen. `inactive` (a call, the control center) keeps the stream. */
const onScreen = (state: string) => state !== 'background';

/**
 * The pull requests of the relay for the signed-in session: read at the sign-in and when the person
 * pulls the list, then kept live by the stream of the relay (`/state/events`) while the app is in the
 * foreground. With no stream, the list is read every minute. Only the last read changes the list. A
 * 401 calls `onExpired`: the relay may no longer know the session.
 */
export function usePulls(
  connection: RelayConnection | undefined,
  fetchFn: typeof fetch,
  onExpired: (connection: RelayConnection) => void,
) {
  // The list belongs to a session: another session starts from the first read, and the list of the
  // one before never shows.
  const [entry, setEntry] = useState<{ session?: string; pulls: PullsState }>({ pulls: FIRST_READ });
  const last = useRef(0);
  const current = useRef(connection);
  const expired = useRef(onExpired);
  const cursor = useRef<string | undefined>(undefined);
  const [active, setActive] = useState(() => onScreen(AppState.currentState));
  const [stream, setStream] = useState<{ session: string; state: RelayState }>();
  const session = connection?.session;
  const pulls = entry.session === session ? entry.pulls : FIRST_READ;
  const live = stream?.session === session ? stream?.state : undefined;
  const ready = pulls.state !== undefined;

  // Before the effects below: they read the connection and the cursor of this render.
  useEffect(() => {
    current.current = connection;
    expired.current = onExpired;
    cursor.current = pulls.state?.cursor;
  }, [connection, onExpired, pulls.state?.cursor]);

  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => setActive(onScreen(next)));
    return () => listener.remove();
  }, []);

  const read = useCallback(
    async (pulled: boolean) => {
      const connection = current.current;
      if (!connection) return;
      const id = ++last.current;
      const update = (change: (state: PullsState) => PullsState) =>
        setEntry((before) => ({
          session: connection.session,
          pulls: change(before.session === connection.session ? before.pulls : FIRST_READ),
        }));
      update((state) => startRead(state, pulled));
      const result = await readState(connection, fetchFn);
      // A newer read, a sign-out or another session came meanwhile.
      if (id !== last.current || current.current?.session !== connection.session) return;
      if (result.status === 'expired') expired.current(connection);
      update((state) => afterRead(state, result.status === 'expired' ? SESSION_REFUSED : result));
    },
    [fetchFn],
  );

  useEffect(() => {
    if (session) void read(false);
  }, [session, read]);

  // The stream opens after the first read, from its cursor, and closes in the background. Back in the
  // foreground, it opens again from the cursor of the last read, not from the last event: an event
  // whose read did not happen before the stop comes again, and gets its read. During one stream, the
  // reader of core resumes from its last event id, which a read cannot pass: each read gives the
  // cursor of an event that the stream sent, or will send. Another session starts another stream.
  useEffect(() => {
    const connection = current.current;
    if (!session || !active || !ready || !connection) return;
    return startLive({
      connection,
      fetch: fetchFn,
      cursor: cursor.current,
      read: () => void read(false),
      onState: (state) => {
        setStream({ session, state });
        if (state === 'expired') expired.current(connection);
      },
    });
  }, [session, active, ready, read, fetchFn]);

  useEffect(() => {
    if (!session || !active || live === 'live') return;
    const timer = setInterval(() => void read(false), POLL_MS);
    return () => clearInterval(timer);
  }, [session, active, live, read]);

  return { pulls, live, refresh: () => void read(true) };
}
