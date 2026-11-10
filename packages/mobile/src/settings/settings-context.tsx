import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRelayContext } from '../relay/relay-context';
import { readSettings, writeSettings, type WatchConfig } from './remote';

export type RemoteSettings =
  | { status: 'idle' | 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; config: WatchConfig; saving: boolean; error?: string };

interface SettingsContextValue {
  remote: RemoteSettings;
  /** Reads the settings again, after a failed read. */
  retry: () => void;
  /** Writes `config` to the relay. Gives the problem to show, or undefined after a save. */
  save: (config: WatchConfig) => Promise<string | undefined>;
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

/**
 * What the relay follows for the user, read once for every screen of the settings (D6: the settings
 * live on the relay, and the last write wins). It needs a `RelayProvider` above it.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const relay = useRelayContext();
  const connection = relay.state.status === 'signedIn' ? relay.state.connection : undefined;
  const key = connection ? `${connection.url} ${connection.session}` : '';
  const [attempt, setAttempt] = useState(0);
  const [stored, setStored] = useState<{ key: string; remote: RemoteSettings }>({
    key: '',
    remote: { status: 'idle' },
  });
  let remote: RemoteSettings = { status: 'idle' };
  if (connection) remote = stored.key === key ? stored.remote : { status: 'loading' };
  const { recheck } = relay;

  useEffect(() => {
    if (!connection) return;
    let current = true;
    void readSettings(connection, fetch).then((result) => {
      if (!current) return;
      // The relay no longer knows the session: the check of the session signs out.
      if (result.status === 'expired') return void recheck(connection);
      setStored({
        key,
        remote: result.status === 'ok' ? { status: 'ready', config: result.config, saving: false } : result,
      });
    });
    return () => {
      current = false;
    };
  }, [connection, key, attempt, recheck]);

  const save = useCallback(
    async (config: WatchConfig) => {
      if (!connection) return 'Sign in to change the settings.';
      setStored((before) =>
        before.key === key && before.remote.status === 'ready'
          ? { key, remote: { ...before.remote, saving: true, error: undefined } }
          : before,
      );
      const result = await writeSettings(connection, fetch, config);
      if (result.status === 'expired') {
        void recheck(connection);
        return 'The relay no longer knows this session.';
      }
      setStored((before) => {
        if (before.key !== key || before.remote.status !== 'ready') return before;
        // The relay gives back what it keeps: the repositories with their owner.
        if (result.status === 'ok') return { key, remote: { status: 'ready', config: result.config, saving: false } };
        return { key, remote: { ...before.remote, saving: false, error: result.message } };
      });
      return result.status === 'failed' ? result.message : undefined;
    },
    [connection, key, recheck],
  );

  return (
    <SettingsContext.Provider value={{ remote, retry: () => setAttempt((count) => count + 1), save }}>
      {children}
    </SettingsContext.Provider>
  );
}

/** The settings of `SettingsProvider`. */
export function useSettings() {
  const settings = useContext(SettingsContext);
  if (!settings) throw new Error('useSettings needs a SettingsProvider above it.');
  return settings;
}
