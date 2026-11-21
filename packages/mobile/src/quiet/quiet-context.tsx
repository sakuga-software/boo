import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRelayContext } from '../relay/relay-context';
import { useSettings } from '../settings/settings-context';
import { useNow } from '../ui/use-now';
import { readQuiet, snoozeEnd, withReadyThrough, withSnooze, type QuietState } from './quiet';

interface QuietContextValue {
  /** The end of the snooze, or undefined if there is none. */
  until?: Date;
  /** The count of the pushes that wait for the recap. Undefined until the relay answers. */
  held?: number;
  /** "Ready to merge" goes out during a hold. */
  readyThrough: boolean;
  /** Undefined until the settings are read: the snooze cannot change before. */
  snooze?: (until: Date | undefined) => Promise<string | undefined>;
  setReadyThrough?: (on: boolean) => Promise<string | undefined>;
}

const QuietContext = createContext<QuietContextValue>({ readyThrough: false });

const READ_EVERY_MS = 60_000;

/**
 * BOO-35: the snooze of the pushes. It lives in the settings on the relay, so it holds every phone of
 * the user; `GET /quiet` gives the count of the pushes that wait. It needs a `SettingsProvider` above it.
 */
export function QuietProvider({ children }: { children: ReactNode }) {
  const relay = useRelayContext();
  const { remote, save } = useSettings();
  const now = useNow();
  const connection = relay.state.status === 'signedIn' ? relay.state.connection : undefined;
  const config = remote.status === 'ready' ? remote.config : undefined;
  const [state, setState] = useState<QuietState>();
  const [reads, setReads] = useState(0);

  useEffect(() => {
    if (!connection) return;
    let current = true;
    const read = () =>
      void readQuiet(connection, fetch).then((result) => {
        // An old relay has no /quiet: the count stays unknown.
        if (current) setState(result.status === 'ok' ? result.value : undefined);
      });
    read();
    const timer = setInterval(read, READ_EVERY_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [connection, config, reads]);

  const snooze = useCallback(
    async (until: Date | undefined) => {
      if (!config) return 'The settings are not read yet.';
      const problem = await save(withSnooze(config, until));
      setReads((count) => count + 1);
      return problem;
    },
    [config, save],
  );
  const setReadyThrough = useCallback(
    (on: boolean) => (config ? save(withReadyThrough(config, on)) : Promise.resolve('The settings are not read yet.')),
    [config, save],
  );

  const until = snoozeEnd(config, now);
  const value: QuietContextValue = {
    ...(until && { until }),
    ...(state && { held: state.held }),
    readyThrough: config?.settings.quiet?.through?.includes('ready') ?? false,
    ...(config && { snooze, setReadyThrough }),
  };
  return <QuietContext.Provider value={value}>{children}</QuietContext.Provider>;
}

export const useQuiet = () => useContext(QuietContext);
