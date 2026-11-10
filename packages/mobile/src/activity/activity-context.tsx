import { File, Paths } from 'expo-file-system';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { usePullsContext } from '../pulls/pulls-context';
import { useRelayContext } from '../relay/relay-context';
import { eventsBetween, parseLog, unreadCount, withEvents, type ActivityLog } from './events';

interface Activity {
  log: ActivityLog;
  unread: number;
  /** Marks every event as read. */
  readAll: () => void;
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
  const [entry, setEntry] = useState<{ login: string; log: ActivityLog }>();
  const previous = useRef<{ login: string; reports: PullRequestReport[] }>(undefined);
  const log = entry && entry.login === login ? entry.log : undefined;
  const latest = useRef(log);
  useEffect(() => {
    latest.current = log;
  }, [log]);
  const loaded = log !== undefined;

  useEffect(() => {
    if (!login) return;
    let current = true;
    const file = fileOf(login);
    const read = file.exists ? file.text() : Promise.resolve(undefined);
    void read
      .catch(() => undefined)
      .then((text) => {
        if (current) setEntry({ login, log: parseLog(text, new Date()) });
      });
    return () => {
      current = false;
    };
  }, [login]);

  const reports = pulls.state?.reports;
  const at = pulls.state?.at;
  // Only a new list gives events. The log comes from a ref: a change of the log must not compare a list
  // with itself.
  useEffect(() => {
    const current = latest.current;
    if (!login || !reports || !at || !loaded || !current) return;
    const before = previous.current?.login === login ? previous.current.reports : undefined;
    previous.current = { login, reports };
    if (!before) return;
    const events = eventsBetween(before, reports, new Date(at), (index) => `${at}-${index}`);
    if (events.length > 0) setEntry({ login, log: withEvents(current, events) });
  }, [login, reports, at, loaded]);

  useEffect(() => {
    if (!login || !log) return;
    try {
      fileOf(login).write(JSON.stringify(log));
    } catch {
      // A full disk loses the activity of this session, not the app.
    }
  }, [login, log]);

  const value: Activity = log
    ? {
        log,
        unread: unreadCount(log),
        readAll: () => setEntry({ login: login!, log: { ...log, readAt: new Date().toISOString() } }),
      }
    : EMPTY;
  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

/** The activity of `ActivityProvider`. */
export const useActivity = () => useContext(ActivityContext);
