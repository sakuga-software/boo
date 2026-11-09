import { closeRelaySession, type RelayConnection } from '@sakuga-software/boo-core/relay';

export interface SignOutDeps {
  fetch: typeof fetch;
  /** Forgets the connection on the phone. */
  forget: () => Promise<void>;
}

/**
 * The sign-out of a session: `DELETE /sessions` on the relay, then the phone forgets the connection.
 * A relay that does not answer keeps the session until it expires; the phone forgets it anyway.
 *
 * Two taps can come before the screen renders the first sign-out, so the button is not yet disabled
 * (finding #55f5ef of #142). A second call for the same session waits for the first one and sends nothing.
 */
export function signOutOnce(deps: SignOutDeps): (connection: RelayConnection) => Promise<void> {
  const running = new Map<string, Promise<void>>();
  return (connection) => {
    const key = `${connection.url} ${connection.session}`;
    const current = running.get(key);
    if (current) return current;
    const run = (async () => {
      await closeRelaySession(connection, { fetch: deps.fetch, log: () => {} });
      await deps.forget().catch(() => {});
    })().finally(() => running.delete(key));
    running.set(key, run);
    return run;
  };
}
