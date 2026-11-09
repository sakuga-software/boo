import type { RelayConnection } from '@sakuga-software/boo-core/relay';

/** The key of the connection in the secure store of the phone. */
export const CONNECTION_KEY = 'boo.relay.connection';

/** Reads a stored connection. A value that is not a full connection gives `undefined`. */
export function parseConnection(stored: string | null): RelayConnection | undefined {
  if (!stored) return undefined;
  try {
    const value = JSON.parse(stored) as Partial<RelayConnection>;
    return typeof value.url === 'string' && typeof value.session === 'string' && typeof value.login === 'string'
      ? { url: value.url, session: value.session, login: value.login }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Calls the relay through `fetchFn`. A call that its signal stopped fails with the reason of the signal, as in a browser. */
export function withAbortReason(fetchFn: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    try {
      return await fetchFn(input, init);
    } catch (error) {
      // expo/fetch gives its own error when a signal stops the call. Core reads the name of the reason:
      // `TimeoutError` becomes "did not answer in 15 s".
      if (init?.signal?.aborted && init.signal.reason !== undefined) throw init.signal.reason;
      throw error;
    }
  }) as typeof fetch;
}
