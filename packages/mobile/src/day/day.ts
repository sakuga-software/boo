import { agentName } from '@sakuga-software/boo-core/agents';
import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import type { Tone } from '@sakuga-software/boo-core/theme';
import { relayGet } from '../quiet/quiet';
import { triage } from '../pulls/triage';

/** A pull request merged in the day, as `GET /state/day` gives it. */
export interface MergedPull {
  repo: string;
  number: number;
  title: string;
  author: string | null;
  agent: string | null;
  mergedAt: string;
  mergedBy: string | null;
  reviews: number;
  firstSeenAt: string;
}

export interface DayWork {
  date: string;
  merged: MergedPull[];
  previousMerged: number;
  reviews: number;
  redChecks: number;
  historySince: string | null;
}

export const isDayWork = (body: unknown): body is DayWork =>
  typeof body === 'object' &&
  body !== null &&
  Array.isArray((body as DayWork).merged) &&
  typeof (body as DayWork).previousMerged === 'number';

export const readDay = (connection: RelayConnection, fetchFn: typeof fetch, date: string, timeZone: string) =>
  relayGet(
    connection,
    fetchFn,
    `/state/day?date=${encodeURIComponent(date)}&tz=${encodeURIComponent(timeZone)}`,
    isDayWork,
  );

const pad = (value: number) => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of `at` on the phone. */
export const dateOf = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** The date `days` after `date`. */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return dateOf(new Date(year!, month! - 1, day! + days));
}

/** `Friday 21 Nov`, or `Today` and `Yesterday`. */
export function dayTitle(date: string, now: Date): string {
  if (date === dateOf(now)) return 'Today';
  if (date === shiftDate(dateOf(now), -1)) return 'Yesterday';
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
}

/** The time from the first sight of the relay to the merge, in minutes. */
export const mergeMinutes = (pull: MergedPull) =>
  Math.max(0, Math.round((Date.parse(pull.mergedAt) - Date.parse(pull.firstSeenAt)) / 60_000));

/** `48 min`, `1h12`. */
export function shortDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}`;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export interface AgentShare {
  key: string;
  label: string;
  count: number;
  tone: Tone | 'claude';
}

const TONES: Record<string, Tone | 'claude'> = { claude: 'claude', copilot: 'blue', codex: 'cyan', people: 'gray' };

/** The merges of the day by agent, the most first. A pull request with no agent is the work of a person. */
export function agentShares(merged: readonly MergedPull[]): AgentShare[] {
  const counts = new Map<string, number>();
  for (const pull of merged) counts.set(pull.agent ?? 'people', (counts.get(pull.agent ?? 'people') ?? 0) + 1);
  return [...counts]
    .map(([key, count]) => ({
      key,
      count,
      label: key === 'people' ? 'People' : agentName(key),
      tone: TONES[key] ?? ('magenta' as const),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** What stays for tomorrow: the pull requests that need the person, then the ones ready to merge. */
export function leftForTomorrow(reports: readonly PullRequestReport[], now: Date): PullRequestReport[] {
  const groups = triage(reports, now);
  return [...groups.needs, ...groups.ready];
}

/** The figures of the Today card. */
export function todaySummary(reports: readonly PullRequestReport[], day: DayWork | undefined, now: Date) {
  const groups = triage(reports, now);
  const minutes = median((day?.merged ?? []).map(mergeMinutes));
  return {
    merged: day?.merged.length,
    needs: groups.needs.length,
    ready: groups.ready.length,
    median: minutes === undefined ? undefined : shortDuration(minutes),
  };
}
