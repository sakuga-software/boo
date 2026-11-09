import type { StateRead, UserState } from './read-state';

/** The list of the pull requests on the phone. */
export interface PullsState {
  /** The last list that the relay gave. */
  state?: UserState;
  /** A read of the relay runs. */
  loading: boolean;
  /** The person pulled the list down: the spinner of the pull shows until the read ends. */
  refreshing: boolean;
  /** Why the last read failed. With `state`, the screen shows the older list, and says from when. */
  error?: string;
}

export const FIRST_READ: PullsState = { loading: true, refreshing: false };

/** A read starts. A pull shows its spinner; a read of the app, such as on return to the app, shows none. */
export const startRead = (current: PullsState, pulled: boolean): PullsState => ({
  ...current,
  loading: true,
  refreshing: current.refreshing || pulled,
});

/** The list after a read. A failed read keeps the older list, with the error. */
export function afterRead(current: PullsState, read: Exclude<StateRead, { status: 'expired' }>): PullsState {
  if (read.status === 'read') return { state: read.state, loading: false, refreshing: false };
  return { ...current, loading: false, refreshing: false, error: read.message };
}

/** What the list screen shows: a spinner, an error with no list, an empty list, or the rows. */
export type ListView =
  | { kind: 'first read' }
  | { kind: 'failed'; message: string }
  | { kind: 'empty' | 'rows'; at: Date; reports: UserState['reports']; stale?: string };

/**
 * The view of the list. A list that a failed read kept is stale: the screen says why, and from when
 * the list is.
 */
export function listView(pulls: PullsState): ListView {
  const { state, error } = pulls;
  if (!state) return error && !pulls.loading ? { kind: 'failed', message: error } : { kind: 'first read' };
  const at = new Date(state.at);
  return {
    kind: state.reports.length === 0 ? 'empty' : 'rows',
    at,
    reports: state.reports,
    ...(error && { stale: error }),
  };
}
