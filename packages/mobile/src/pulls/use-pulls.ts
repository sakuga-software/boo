import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { afterRead, FIRST_READ, startRead, type PullsState } from './list';
import { readState } from './read-state';

const SESSION_REFUSED = { status: 'failed', message: 'The relay refused the session.' } as const;

/**
 * The pull requests of the relay for the signed-in session: read at the sign-in, on each return to
 * the app, and when the person pulls the list. Only the last read changes the list. A 401 calls
 * `onExpired`: the relay may no longer know the session.
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
  const session = connection?.session;
  const pulls = entry.session === session ? entry.pulls : FIRST_READ;

  // Before the effect below: its first read reads the connection of this render.
  useEffect(() => {
    current.current = connection;
    expired.current = onExpired;
  }, [connection, onExpired]);

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
    if (!session) return;
    void read(false);
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'active') void read(false);
    });
    return () => listener.remove();
  }, [session, read]);

  return { pulls, refresh: () => void read(true) };
}
