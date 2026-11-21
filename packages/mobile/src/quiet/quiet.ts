import type { WorkHours } from '@sakuga-software/boo-core/quiet';
import { snoozed } from '@sakuga-software/boo-core/quiet';
import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import { withAbortReason } from '../relay/connection';
import type { WatchConfig } from '../settings/remote';
import { formatTime, sameDay } from '../ui/time';

/** The config with the snooze until `until`, or with no snooze. The rest of `quiet` stays. */
export function withSnooze(config: WatchConfig, until: Date | undefined): WatchConfig {
  const { snoozeUntil: _old, ...quiet } = config.settings.quiet ?? {};
  const next = until ? { ...quiet, snoozeUntil: until.toISOString() } : quiet;
  return withQuiet(config, next);
}

/** The config with "Ready to merge" let out of a hold, or not. */
export function withReadyThrough(config: WatchConfig, on: boolean): WatchConfig {
  const { through: _old, ...quiet } = config.settings.quiet ?? {};
  return withQuiet(config, on ? { ...quiet, through: ['ready'] } : quiet);
}

export function withWorkHours(config: WatchConfig, hours: WorkHours | undefined): WatchConfig {
  const { workHours: _old, ...quiet } = config.settings.quiet ?? {};
  return withQuiet(config, hours ? { ...quiet, workHours: hours } : quiet);
}

function withQuiet(config: WatchConfig, quiet: NonNullable<WatchConfig['settings']['quiet']>): WatchConfig {
  const { quiet: _old, ...settings } = config.settings;
  return { ...config, settings: Object.keys(quiet).length > 0 ? { ...settings, quiet } : settings };
}

/** The end of the snooze of `config` at `now`, or undefined if there is no snooze. */
export const snoozeEnd = (config: WatchConfig | undefined, now: Date): Date | undefined => {
  const quiet = config?.settings.quiet;
  return quiet && snoozed(quiet, now) ? new Date(quiet.snoozeUntil!) : undefined;
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `18:00` today, `Mon 09:00` on another day. */
export const untilWords = (until: Date, now: Date) =>
  sameDay(until, now) ? formatTime(until) : `${DAYS[until.getDay()]} ${formatTime(until)}`;

/** `Mon–Fri · 09:00 – 18:00`, or `Off`. */
export function workHoursWords(hours: WorkHours | undefined): string {
  if (!hours) return 'Off · every push at once';
  const days = [...hours.days].sort();
  const run = days.every((day, index) => index === 0 || day === days[index - 1]! + 1);
  let dayWords = days.map((day) => DAYS[day]).join(', ');
  if (days.length === 7) dayWords = 'Every day';
  else if (run && days.length > 2) dayWords = `${DAYS[days[0]!]}–${DAYS[days.at(-1)!]}`;
  return `${dayWords} · ${hours.start} – ${hours.end}`;
}

/** The time zone of the phone, for the work hours and the day. */
export const phoneZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const DEFAULT_WORK_HOURS = (): WorkHours => ({
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
  timeZone: phoneZone(),
});

export type RelayRead<T> = { status: 'ok'; value: T } | { status: 'expired' } | { status: 'failed'; message: string };

/** A GET of the relay with the session token, as `remote.ts` does it: no redirect, a time limit. */
export async function relayGet<T>(
  connection: RelayConnection,
  fetchFn: typeof fetch,
  path: string,
  valid: (body: unknown) => body is T,
  timeoutMs = 15_000,
): Promise<RelayRead<T>> {
  let response: Response;
  try {
    response = await withAbortReason(fetchFn)(`${connection.url}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${connection.session}` },
    });
  } catch {
    return { status: 'failed', message: 'The relay did not answer. Try again later.' };
  }
  if (response.status === 401) return { status: 'expired' };
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) return { status: 'failed', message: `The relay answered ${response.status}.` };
  if (!valid(body)) return { status: 'failed', message: 'The relay is too old for this screen.' };
  return { status: 'ok', value: body };
}

/** `GET /quiet`: the relay holds the pushes now, and this count waits for the recap. */
export interface QuietState {
  holding: boolean;
  held: number;
}

export const isQuietState = (body: unknown): body is QuietState =>
  typeof body === 'object' &&
  body !== null &&
  typeof (body as QuietState).holding === 'boolean' &&
  typeof (body as QuietState).held === 'number';

export const readQuiet = (connection: RelayConnection, fetchFn: typeof fetch) =>
  relayGet(connection, fetchFn, '/quiet', isQuietState);

/** `HH:MM` moved by `minutes`, kept in the day. */
export function shiftHour(hour: string, minutes: number): string {
  const total = Math.min(23 * 60 + 30, Math.max(0, Number(hour.slice(0, 2)) * 60 + Number(hour.slice(3)) + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
