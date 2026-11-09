import { createContext, useContext, type ReactNode } from 'react';
import { useRelay } from './use-relay';

const RelayContext = createContext<ReturnType<typeof useRelay> | undefined>(undefined);

/** Gives one connection to the relay to every screen: a sign-out in the settings shows on the home screen. */
export function RelayProvider({ children }: { children: ReactNode }) {
  return <RelayContext.Provider value={useRelay()}>{children}</RelayContext.Provider>;
}

/** The connection to the relay of `RelayProvider`. */
export function useRelayContext() {
  const relay = useContext(RelayContext);
  if (!relay) throw new Error('useRelayContext needs a RelayProvider above it.');
  return relay;
}
