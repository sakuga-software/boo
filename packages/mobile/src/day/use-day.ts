import { useEffect, useState } from 'react';
import { phoneZone } from '../quiet/quiet';
import { useRelayContext } from '../relay/relay-context';
import { readDay, type DayWork } from './day';

export type DayRead =
  | { status: 'loading' }
  | { status: 'ready'; work: DayWork }
  | { status: 'failed'; message: string };

/** The work of `date` (`YYYY-MM-DD` on the phone), read from the relay. `again` reads it again when it changes. */
export function useDay(date: string, again: unknown = undefined): DayRead {
  const relay = useRelayContext();
  const connection = relay.state.status === 'signedIn' ? relay.state.connection : undefined;
  const [read, setRead] = useState<{ key: string; value: DayRead }>({ key: '', value: { status: 'loading' } });
  const key = `${connection?.url} ${date}`;
  const { recheck } = relay;

  useEffect(() => {
    if (!connection) return;
    let current = true;
    void readDay(connection, fetch, date, phoneZone()).then((result) => {
      if (!current) return;
      if (result.status === 'expired') return void recheck(connection);
      setRead({ key, value: result.status === 'ok' ? { status: 'ready', work: result.value } : result });
    });
    return () => {
      current = false;
    };
  }, [connection, date, key, recheck, again]);

  return read.key === key ? read.value : { status: 'loading' };
}
