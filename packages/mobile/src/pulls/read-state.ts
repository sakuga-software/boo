import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import type { PullRequestReport } from '@sakuga-software/boo-core/report';

/** The reports of the user, as `GET /state` of the relay gives them. */
export interface UserState {
  /** Changes each time the reports change. */
  cursor: string;
  /** The time when the relay computed the reports. */
  at: string;
  reports: PullRequestReport[];
}

/** The answer of the relay: the reports, a session that it no longer knows, or a failure to show. */
export type StateRead =
  | { status: 'read'; state: UserState }
  | { status: 'expired' }
  | { status: 'failed'; message: string };

const TIMEOUT_MS = 15_000;

const isUserState = (value: unknown): value is UserState => {
  const state = value as Partial<UserState> | null;
  return (
    typeof state === 'object' &&
    state !== null &&
    typeof state.cursor === 'string' &&
    typeof state.at === 'string' &&
    Array.isArray(state.reports)
  );
};

/**
 * Reads `GET /state` with the session token. The HTTP status tells a session that the relay no longer
 * knows (401) from a relay that cannot answer now. The token never follows a redirect.
 */
export async function readState(
  connection: RelayConnection,
  fetchFn: typeof fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<StateRead> {
  let response: Response;
  try {
    response = await fetchFn(`${connection.url}/state`, {
      redirect: 'error',
      headers: { authorization: `Bearer ${connection.session}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // The reason of the signal can be a DOMException, which is not an Error on every engine.
    if ((error as { name?: unknown } | null)?.name === 'TimeoutError')
      return { status: 'failed', message: `The relay did not answer in ${timeoutMs / 1000} s.` };
    return { status: 'failed', message: 'The relay cannot be reached. Check the network.' };
  }
  if (response.status === 401) return { status: 'expired' };
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = (body as { error?: unknown } | undefined)?.error;
    return {
      status: 'failed',
      message: `The relay refused the list: ${response.status}${typeof error === 'string' ? ` ${error}` : ''}`,
    };
  }
  if (!isUserState(body)) return { status: 'failed', message: 'The relay gave a list that the app cannot read.' };
  return { status: 'read', state: body };
}
