import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import type { RelayState } from './state';

export interface ChangeRelayDeps {
  /** Asks the new URL if it is a boo relay. Returns the problem, or `undefined`. */
  probe: (url: string) => Promise<string | undefined>;
  /** The state of the screen now, not the one of an older render. */
  current: () => RelayState;
  /** Shows the sign-out on the screen. */
  markSigningOut: () => void;
  /** Signs out of the session (`signOutOnce`). */
  endSession: (connection: RelayConnection) => Promise<void>;
  /** Keeps the chosen relay on the phone. `undefined`: the relay of `app.json`. A failure keeps the relay until a restart. */
  store: (url: string | undefined) => Promise<void>;
}

export type ChangeResult = { relayUrl: string; problem?: undefined } | { problem: string };

const busy = (state: RelayState) => {
  if (state.status === 'loading' || state.status === 'signingIn') return 'Wait for the sign-in to end.';
  if (state.status === 'signedIn' && state.signingOut) return 'Wait for the sign-out to end.';
  return undefined;
};

/**
 * Moves the app to another relay (`url`), or back to the relay of `app.json` (`undefined`, which is
 * `fallback`). The new relay must answer as a boo relay first. Then the app signs out of the session
 * of the state at that time: the probe can take 15 s, and the session can end meanwhile (a sign-out,
 * a 401). One change runs at a time: a second tap can come before the render that disables the button.
 */
export function relayChanger(deps: ChangeRelayDeps, fallback: string) {
  let running = false;
  return async (url: string | undefined): Promise<ChangeResult> => {
    const before = busy(deps.current());
    if (before) return { problem: before };
    if (running) return { problem: 'The relay is already changing.' };
    running = true;
    try {
      const next = url ?? fallback;
      const problem = await deps.probe(next);
      if (problem) return { problem };
      const now = deps.current();
      const after = busy(now);
      if (after) return { problem: after };
      if (now.status === 'signedIn') {
        deps.markSigningOut();
        await deps.endSession(now.connection);
      }
      await deps.store(url).catch(() => {});
      return { relayUrl: next };
    } finally {
      running = false;
    }
  };
}
