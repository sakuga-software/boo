import type { PushState } from './settings.js';

/**
 * BOO-35. The hold of the push notifications: a snooze, and the work hours of each week. During a
 * hold, the relay keeps the changes and sends one recap at its end. Outside the work hours, the
 * relay holds the pushes too, and the end of the work hours sends the recap of the day.
 */
export interface WorkHours {
  /** The days of the work, 0 for Sunday to 6 for Saturday. */
  days: number[];
  /** `HH:MM`, in `timeZone`. */
  start: string;
  end: string;
  /** An IANA time zone, such as `Europe/Paris`. */
  timeZone: string;
}

export interface Quiet {
  /** ISO time. Before it, the relay holds the pushes. */
  snoozeUntil?: string;
  /** The states that go out during a hold. */
  through?: PushState[];
  workHours?: WorkHours;
}

const HOUR = /^([01]\d|2[0-3]):([0-5]\d)$/;

const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Reads the `quiet` key of the settings. Undefined if nothing in it is valid. */
export function parseQuiet(value: unknown, states: readonly string[]): Quiet | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const stored = value as Record<string, unknown>;
  const quiet: Quiet = {};
  if (typeof stored.snoozeUntil === 'string' && !Number.isNaN(Date.parse(stored.snoozeUntil)))
    quiet.snoozeUntil = new Date(stored.snoozeUntil).toISOString();
  if (Array.isArray(stored.through)) {
    const through = [...new Set(stored.through.filter((state): state is PushState => states.includes(state)))];
    if (through.length > 0) quiet.through = through;
  }
  const hours = stored.workHours;
  if (typeof hours === 'object' && hours !== null && !Array.isArray(hours)) {
    const { days, start, end, timeZone } = hours as Record<string, unknown>;
    const valid =
      Array.isArray(days) &&
      typeof start === 'string' &&
      typeof end === 'string' &&
      HOUR.test(start) &&
      HOUR.test(end) &&
      start < end &&
      typeof timeZone === 'string' &&
      validZone(timeZone);
    if (valid) {
      const workDays = [...new Set(days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))];
      if (workDays.length > 0) quiet.workHours = { days: workDays.sort(), start, end, timeZone };
    }
  }
  return Object.keys(quiet).length > 0 ? quiet : undefined;
}

/** The date (`YYYY-MM-DD`), the day of the week and the minute of the day of `at` in `timeZone`. */
export function localTime(at: Date, timeZone: string): { date: string; day: number; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day: days.indexOf(parts.weekday!),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const minutesOf = (hour: string) => Number(hour.slice(0, 2)) * 60 + Number(hour.slice(3));

/** The instant of the wall time `date` (`YYYY-MM-DD`) at `hour` (`HH:MM`) in `timeZone`. */
export function instantOf(date: string, hour: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year!, month! - 1, day!, Number(hour.slice(0, 2)), Number(hour.slice(3)));
  // The offset of the zone at a time near the result. Two passes make it right around a change of
  // daylight saving time.
  let at = wall;
  for (let pass = 0; pass < 2; pass++) {
    const local = localTime(new Date(at), timeZone);
    const [y, m, d] = local.date.split('-').map(Number);
    const seen = Date.UTC(y!, m! - 1, d!, Math.floor(local.minutes / 60), local.minutes % 60);
    at += wall - seen;
  }
  return new Date(at);
}

/** The date `days` after `date`, both `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export const inWorkHours = (hours: WorkHours, at: Date): boolean => {
  const local = localTime(at, hours.timeZone);
  return (
    hours.days.includes(local.day) && local.minutes >= minutesOf(hours.start) && local.minutes < minutesOf(hours.end)
  );
};

export const snoozed = (quiet: Quiet | undefined, at: Date): boolean =>
  !!quiet?.snoozeUntil && Date.parse(quiet.snoozeUntil) > at.getTime();

/** True if the relay holds the pushes at `at`: a snooze, or a time outside the work hours. */
export const held = (quiet: Quiet | undefined, at: Date): boolean =>
  snoozed(quiet, at) || (!!quiet?.workHours && !inWorkHours(quiet.workHours, at));

/** The end of the work hours of the day of `at`, if `at` is in the work hours. */
export function workEnd(hours: WorkHours, at: Date): Date | undefined {
  if (!inWorkHours(hours, at)) return undefined;
  return instantOf(localTime(at, hours.timeZone).date, hours.end, hours.timeZone);
}

/** The next start of the work hours after `at`, in the next 8 days. */
export function nextWorkStart(hours: WorkHours, at: Date): Date | undefined {
  const today = localTime(at, hours.timeZone).date;
  for (let offset = 0; offset <= 7; offset++) {
    const date = addDays(today, offset);
    const start = instantOf(date, hours.start, hours.timeZone);
    if (start > at && hours.days.includes(localTime(start, hours.timeZone).day)) return start;
  }
  return undefined;
}

export interface SnoozePreset {
  label: string;
  /** The end, in words, for the line under the label. */
  detail: string;
  until: Date;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The snoozes that the app offers at `at`. They depend on the time:
 * - "Until <end>" only in the work hours, and only if the end is more than one hour away;
 * - "Until tomorrow" is the next start of the work hours: on a Friday, "Until Monday".
 * With no work hours, the morning is 09:00 tomorrow in `timeZone`.
 */
export function snoozePresets(quiet: Quiet | undefined, at: Date, timeZone: string): SnoozePreset[] {
  const zone = quiet?.workHours?.timeZone ?? timeZone;
  const clock = (date: Date) => {
    const { minutes } = localTime(date, zone);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  };
  const presets: SnoozePreset[] = [
    {
      label: '1 hour',
      detail: `until ${clock(new Date(at.getTime() + 3_600_000))}`,
      until: new Date(at.getTime() + 3_600_000),
    },
    {
      label: '3 hours',
      detail: `until ${clock(new Date(at.getTime() + 3 * 3_600_000))}`,
      until: new Date(at.getTime() + 3 * 3_600_000),
    },
  ];
  const hours = quiet?.workHours;
  const end = hours && workEnd(hours, at);
  if (end && end.getTime() - at.getTime() > 3_600_000)
    presets.push({ label: `Until ${clock(end)}`, detail: 'end of work hours', until: end });
  const morning = hours ? nextWorkStart(hours, at) : instantOf(addDays(localTime(at, zone).date, 1), '09:00', zone);
  if (morning) {
    const today = localTime(at, zone).date;
    const day = localTime(morning, zone);
    const label = day.date === addDays(today, 1) ? 'Until tomorrow' : `Until ${DAY_NAMES[day.day]}`;
    presets.push({ label, detail: `${DAY_NAMES[day.day]!.slice(0, 3)} ${clock(morning)}`, until: morning });
  }
  return presets;
}
