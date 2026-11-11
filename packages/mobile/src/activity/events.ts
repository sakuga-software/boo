import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { displayName } from '@sakuga-software/boo-core/reviewers';
import type { Tone } from '@sakuga-software/boo-core/theme';
import type { IconName } from '../ui/icons';
import { failedChecks, shortName } from '../pulls/triage';
import { reportKey } from '../pulls/view';

/** A change of a pull request that the phone saw between two lists of the relay. */
export interface ActivityEvent {
  id: string;
  /** `owner/name#number`. */
  key: string;
  icon: IconName;
  tone: Tone;
  what: string;
  /** The account that did the change, for its avatar. Undefined: the change has no author. */
  actor?: string;
  /** `web#921`. */
  name: string;
  title: string;
  at: string;
  /** The pull request is ready to merge: the row has a Merge button. */
  canMerge?: boolean;
}

type Report = PullRequestReport;

const latestReviewer = (report: Report, mark: string) => {
  let last: Report['reviewers'][number] | undefined;
  for (const reviewer of report.reviewers)
    if (reviewer.mark === mark && (!last || Date.parse(reviewer.at ?? '') > Date.parse(last.at ?? ''))) last = reviewer;
  return last;
};

function changesOf(before: Report, after: Report): Omit<ActivityEvent, 'id' | 'key' | 'name' | 'title' | 'at'>[] {
  const out: Omit<ActivityEvent, 'id' | 'key' | 'name' | 'title' | 'at'>[] = [];
  if (after.state !== before.state) {
    switch (after.state) {
      case 'ready to merge':
        out.push({ icon: 'check', tone: 'green', what: 'Ready to merge', canMerge: true });
        break;
      case 'changes requested': {
        const reviewer = latestReviewer(after, 'changes requested');
        const name = reviewer ? displayName(reviewer.login) : undefined;
        out.push({
          icon: 'pencil',
          tone: 'red',
          what: name ? `${name} requested changes` : 'Changes requested',
          ...(reviewer && { actor: reviewer.login }),
        });
        break;
      }
      case 'checks failing': {
        const first = failedChecks(after.checks).find((check) => !before.checks.failing.includes(check));
        out.push({ icon: 'x', tone: 'red', what: first ? `${first} failed` : 'Checks failing' });
        break;
      }
      case 'conflicts':
        out.push({ icon: 'warn', tone: 'red', what: `Conflicts with ${after.base ?? 'the base branch'}` });
        break;
      case 'merged':
        out.push({
          icon: 'merged',
          tone: 'magenta',
          what: after.mergedBy ? `Merged by ${displayName(after.mergedBy)}` : 'Merged',
          ...(after.mergedBy && { actor: after.mergedBy }),
        });
        break;
      case 'closed':
        out.push({ icon: 'x', tone: 'gray', what: 'Closed' });
        break;
    }
  }
  if (after.stalled && !before.stalled) out.push({ icon: 'zz', tone: 'yellow', what: 'Stalled, no new commit' });
  for (const reviewer of after.reviewers) {
    if (reviewer.mark !== 'commented' || !reviewer.at) continue;
    const old = before.reviewers.find((other) => other.login === reviewer.login);
    if (old?.at === reviewer.at) continue;
    const score = reviewer.score ? ` · ${reviewer.score.score}/${reviewer.score.total}` : '';
    out.push({
      icon: 'dot',
      tone: 'cyan',
      what: `${displayName(reviewer.login)} commented${score}`,
      actor: reviewer.login,
    });
  }
  return out;
}

/**
 * The events between two lists of the relay, newest first. A pull request that only one list has
 * gives none: the first list of a session would fill the activity with the whole list.
 */
export function eventsBetween(
  before: readonly Report[],
  after: readonly Report[],
  at: Date,
  idOf: (key: string, index: number) => string,
): ActivityEvent[] {
  const old = new Map(before.map((report) => [reportKey(report), report]));
  const events: ActivityEvent[] = [];
  for (const report of after) {
    const previous = old.get(reportKey(report));
    if (!previous) continue;
    for (const change of changesOf(previous, report))
      events.push({
        ...change,
        id: idOf(reportKey(report), events.length),
        key: reportKey(report),
        name: shortName(report),
        title: report.title,
        at: at.toISOString(),
      });
  }
  return events;
}

/** The activity that the phone keeps: the events, newest first, and the time of the last read. */
export interface ActivityLog {
  events: ActivityEvent[];
  /** The events after this time are unread. */
  readAt: string;
}

export const MAX_EVENTS = 200;

/** The log with new events on top, cut to `MAX_EVENTS`. */
export const withEvents = (log: ActivityLog, events: readonly ActivityEvent[]): ActivityLog =>
  events.length === 0 ? log : { ...log, events: [...events, ...log.events].slice(0, MAX_EVENTS) };

export const isUnread = (log: ActivityLog, event: ActivityEvent) => event.at > log.readAt;

export const unreadCount = (log: ActivityLog) => log.events.filter((event) => isUnread(log, event)).length;

/** The label of the day of an event: `Today`, `Yesterday`, or the date. The last hour is `Now`. */
export function dayLabel(now: Date, at: Date): string {
  if (now.getTime() - at.getTime() < 60 * 60_000) return 'Now';
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return at.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** The events in groups of one day label, in their order. */
export function groupByDay(events: readonly ActivityEvent[], now: Date) {
  const groups: { label: string; events: ActivityEvent[] }[] = [];
  for (const event of events) {
    const label = dayLabel(now, new Date(event.at));
    const last = groups[groups.length - 1];
    if (last?.label === label) last.events.push(event);
    else groups.push({ label, events: [event] });
  }
  return groups;
}

/**
 * Reads the log of the phone. `writable` is false when the file exists but the read failed: a write
 * would then replace an activity that a later read could still give.
 */
export async function loadLog(
  read: () => Promise<string | undefined>,
  now: Date,
): Promise<{ log: ActivityLog; writable: boolean }> {
  try {
    return { log: parseLog(await read(), now), writable: true };
  } catch {
    return { log: parseLog(undefined, now), writable: false };
  }
}

/** A log read from a file, or an empty log if the text is not one. */
export function parseLog(text: string | undefined, now: Date): ActivityLog {
  const empty = { events: [], readAt: now.toISOString() };
  if (!text) return empty;
  try {
    const log = JSON.parse(text) as Partial<ActivityLog>;
    if (!Array.isArray(log.events) || typeof log.readAt !== 'string') return empty;
    return { events: log.events.slice(0, MAX_EVENTS), readAt: log.readAt };
  } catch {
    return empty;
  }
}
