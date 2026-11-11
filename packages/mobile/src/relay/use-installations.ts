import { readInstallations } from '@sakuga-software/boo-core/relay';
import { useEffect, useState } from 'react';
import { withAbortReason } from './connection';
import { useRelayContext } from './relay-context';

export interface Installation {
  account: string;
  /** The App has the write permissions of a merge here. A relay older than the merge does not say. */
  canMerge?: boolean;
}

const relayFetch = withAbortReason(fetch);

/** The installations of the App that the person reads, read once for each screen that asks. */
export function useInstallations(): Installation[] | undefined {
  const relay = useRelayContext();
  const connection = relay.state.status === 'signedIn' ? relay.state.connection : undefined;
  const [entry, setEntry] = useState<{ session: string; list: Installation[] }>();
  useEffect(() => {
    if (!connection) return;
    let current = true;
    readInstallations(connection, { fetch: relayFetch }).then(
      ({ installations }) => {
        if (current) setEntry({ session: connection.session, list: installations as Installation[] });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [connection]);
  return entry && entry.session === connection?.session ? entry.list : undefined;
}
