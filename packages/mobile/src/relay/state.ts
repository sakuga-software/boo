import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import type { SessionCheck } from './connection';
import type { SignInStep } from './sign-in';

export type RelayState =
  | { status: 'loading' }
  | { status: 'signedOut'; notice?: string }
  | { status: 'signingIn'; step: SignInStep }
  | {
      status: 'signedIn';
      connection: RelayConnection;
      /** Set when the user reads no installation of the App: the page that installs it. */
      installUrl?: string;
      /** A line for the person, for example when a check that they asked for gets no answer. */
      notice?: string;
      signingOut?: boolean;
    };

export const EXPIRED_NOTICE = 'The relay ended the session. Sign in again.';
export const NO_ANSWER_NOTICE = 'The relay did not answer. Try again later.';

/**
 * The state after a check of the session. Only the screen of the same session changes: a check that
 * ends after a sign-out or another sign-in changes nothing. `asked`: the person tapped "Check again",
 * so a relay that does not answer gets a notice; an automatic check stays quiet.
 */
export function afterCheck(
  current: RelayState,
  connection: RelayConnection,
  check: SessionCheck,
  asked: boolean,
): RelayState {
  if (current.status !== 'signedIn' || current.connection.session !== connection.session) return current;
  if (check.status === 'expired') return { status: 'signedOut', notice: EXPIRED_NOTICE };
  const { installUrl, notice, ...rest } = current;
  if (check.status === 'unknown') return asked ? { ...current, notice: NO_ANSWER_NOTICE } : current;
  return { ...rest, ...(check.installUrl && { installUrl: check.installUrl }) };
}

/** Marks the sign-out on the screen that is there now, not on the one of an older render. */
export const markSigningOut = (current: RelayState): RelayState =>
  current.status === 'signedIn' ? { ...current, signingOut: true } : current;

/** The state after a sign-out. A state that changed meanwhile (an expired session and its notice) stays. */
export const afterSignOut = (current: RelayState, connection: RelayConnection): RelayState =>
  current.status === 'signedIn' && current.connection.session === connection.session
    ? { status: 'signedOut' }
    : current;
