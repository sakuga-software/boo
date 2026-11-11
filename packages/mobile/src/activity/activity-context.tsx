import { File, Paths } from 'expo-file-system';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { usePullsContext } from '../pulls/pulls-context';
import { useRelayContext } from '../relay/relay-context';
import { eventsBetween, loadLog, unreadCount, withEvents, type ActivityLog } from './events';

interface Activity {
  log: ActivityLog;
  unread: number;
  /** Marks every event as read. */
  readAll: () => void;
}

/** The log of one login. `changed`: the log differs from the file. `writable`: the read of the file worked. */
interface Entry {
  login: string;
  log: ActivityLog;
  writable: boolean;
  changed: boolean;
}

const EMPTY: Activity = { log: { events: [], readAt: '' }, unread: 0, readAll: () => {} };
const ActivityContext = createContext<Activity>(EMPTY);

// One file for each login: a phone that changes of account does not show the activity of the other.
const fileOf = (login: string) => new File(Paths.document, `activity-${encodeURIComponent(login)}.json`);

/**
 * Keeps the activity of the pull requests: each change between two lists of the relay that the phone
 * reads. The relay keeps no history, so the activity starts when the app first runs, and a change
 * while the app is closed shows only as the state of the next list.
 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const relay = useRelayContext();
  const { pulls } = usePullsContext();
  const login = relay.state.status === 'signedIn' ? relay.state.connection.login : undefined;
  const [entry, setEntry] = useState<Entry>();
  const previous = useRef<{ login: string; reports: PullRequestReport[] }>(undefined);
  const current = entry && entry.login === login ? entry : undefined;
  const log = current?.log;
  // A change for the login of now: a log that another login loaded meanwhile stays as it is.
  const update = (change: (entry: Entry) => Entry) =>
    setEntry((now) => (now && now.login === login ? change(now) : now));

  useEffect(() => {
    if (!login) return;
    let active = true;
    const file = fileOf(login);
    void loadLog(() => (file.exists ? file.text() : Promise.resolve(undefined)), new Date()).then((loaded) => {
      if (active) setEntry({ login, ...loaded, changed: false });
    });
    return () => {
      active = false;
    };
  }, [login]);

  const reports = pulls.state?.reports;
  const at = pulls.state?.at;
  useEffect(() => {
    if (!login || !reports || !at || !log) return;
    // A change of the log runs this effect again with the same list: that list gave its events already.
    if (previous.current?.login === login && previous.current.reports === reports) return;
    const before = previous.current?.login === login ? previous.current.reports : undefined;
    previous.current = { login, reports };
    if (!before) return;
    const stamp = Date.now().toString(36);
    const events = eventsBetween(before, reports, new Date(at), (key, index) => `${stamp}-${key}-${index}`);
    if (events.length > 0)
      setEntry((now) => (now?.login === login ? { ...now, log: withEvents(now.log, events), changed: true } : now));
  }, [login, reports, at, log]);

  useEffect(() => {
    if (!current?.changed || !current.writable) return;
    try {
      fileOf(current.login).write(JSON.stringify(current.log));
    } catch {
      // A full disk loses the activity of this session, not the app.
    }
  }, [current]);

  const value: Activity = log
    ? {
        log,
        unread: unreadCount(log),
        readAll: () =>
          update((now) => ({ ...now, log: { ...now.log, readAt: new Date().toISOString() }, changed: true })),
      }
    : EMPTY;
  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

/** The activity of `ActivityProvider`. */
export const useActivity = () => useContext(ActivityContext);
