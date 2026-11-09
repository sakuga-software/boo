import { createContext, useContext, type ReactNode } from 'react';
import { withAbortReason } from '../relay/connection';
import { useRelayContext } from '../relay/relay-context';
import { usePulls } from './use-pulls';

const PullsContext = createContext<ReturnType<typeof usePulls> | undefined>(undefined);

const relayFetch = withAbortReason(fetch);

/** Gives one list of the pull requests of the signed-in session to every screen. It needs a `RelayProvider` above it. */
export function PullsProvider({ children }: { children: ReactNode }) {
  const relay = useRelayContext();
  const connection = relay.state.status === 'signedIn' ? relay.state.connection : undefined;
  // A 401 of the list checks the session with the path of the sign-in: a session that the relay no
  // longer knows signs out there, and the phone forgets it.
  const pulls = usePulls(connection, relayFetch, (expired) => void relay.checkAgain(expired));
  return <PullsContext.Provider value={pulls}>{children}</PullsContext.Provider>;
}

/** The list of `PullsProvider`. */
export function usePullsContext() {
  const pulls = useContext(PullsContext);
  if (!pulls) throw new Error('usePullsContext needs a PullsProvider above it.');
  return pulls;
}
