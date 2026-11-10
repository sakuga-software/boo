import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { REVIEWER_MARKS, type Tone } from '@sakuga-software/boo-core/theme';
import type { ReviewerStatus } from '@sakuga-software/boo-core/reviewers';
import { iconOfMark, type IconName } from '../ui/icons';
import { formatTime, sameDay, shortAgo } from '../ui/time';
import { stateView } from './view';

/** The three groups of the list: the person acts, the person merges, the reviewers act. */
export type Group = 'needs' | 'ready' | 'reviewing';

/** An icon of the list and its tone. */
export interface Glyph {
  icon: IconName;
  tone: Tone;
}

// The states where the person, or the agent of the person, must change the code.
const NEEDS = new Set(['conflicts', 'changes requested', 'checks failing', 'error']);

/** The group of a pull request. Undefined: it left the list (merged or closed). */
export function groupOf(report: Pick<PullRequestReport, 'state'>): Group | undefined {
  if (report.state === 'merged' || report.state === 'closed') return undefined;
  if (NEEDS.has(report.state)) return 'needs';
  return report.state === 'ready to merge' ? 'ready' : 'reviewing';
}

/** The repository name and the number, with no owner: `web#921`. */
export const shortName = ({ repo, number }: Pick<PullRequestReport, 'repo' | 'number'>) =>
  `${repo.slice(repo.indexOf('/') + 1)}#${number}`;

/** The time of the head commit: the relay computed `idleMinutes` at `at`, the time of the list. */
export const headTime = (report: Pick<PullRequestReport, 'idleMinutes'>, at: Date) =>
  report.idleMinutes === null ? undefined : new Date(at.getTime() - report.idleMinutes * 60_000);

/** The glyph of the state of a pull request: the icon of the mark of the terminal, in its tone. */
export function stateGlyph(report: Pick<PullRequestReport, 'state' | 'stale'>): Glyph {
  const { mark, tone } = stateView(report);
  return { icon: iconOfMark(mark), tone };
}

/** The badge of a reviewer: the icon of its status, in the tone of the terminal. */
export function reviewerGlyph(mark: string): Glyph {
  const known = REVIEWER_MARKS[mark as ReviewerStatus];
  return known ? { icon: iconOfMark(known.mark), tone: known.tone } : { icon: 'ring', tone: 'gray' };
}

/** The words of a reviewer status, as the details say them. */
export function reviewerWords(mark: string): string {
  if (mark === 'quota') return 'out of quota';
  if (mark === 'stale') return 'older commit';
  return mark;
}

/** The checks that fail because of the change: the red reviewer checks are a failure of the bot. */
export const failedChecks = (checks: PullRequestReport['checks']) => {
  const reviewerErrors = new Set(checks.reviewerErrors.map(({ check }) => check));
  return checks.failing.filter((name) => !reviewerErrors.has(name));
};

/** The best score that a reviewer gave on the pull request, if any. */
export function bestScore(reviewers: PullRequestReport['reviewers']) {
  let best: { score: number; total: number } | undefined;
  for (const { score } of reviewers)
    if (score && (!best || score.score / score.total > best.score / best.total)) best = score;
  return best;
}

/** The colored words of the state on a row: `1 check failing`, `reviewing 2/3`, `quota · back 15:40`. */
export function stateWords(report: PullRequestReport): string {
  switch (report.state) {
    case 'checks failing': {
      const failed = failedChecks(report.checks).length;
      return failed > 0 ? `${failed} check${failed === 1 ? '' : 's'} failing` : 'checks failing';
    }
    case 'reviewing': {
      const onHead = report.reviewers.filter((reviewer) => reviewer.onHead).length;
      return report.reviewers.length > 0 ? `reviewing ${onHead}/${report.reviewers.length}` : 'reviewing';
    }
    case 'quota': {
      const note = report.notes.coderabbit;
      return note?.kind === 'wait' ? `quota · back ${formatTime(new Date(note.availableAt))}` : 'quota';
    }
    case 'error':
      return 'not read';
    default:
      return report.state;
  }
}

/** The muted words after the state on a row: where the pull request is, and since when it waits. */
export function rowMeta(report: PullRequestReport, group: Group, at: Date, now: Date): string {
  const head = headTime(report, at);
  const age = group !== 'reviewing' && head ? ` · ${shortAgo(now, head)}` : '';
  if (group === 'ready') {
    const score = bestScore(report.reviewers);
    return `${score ? `${score.score}/${score.total}` : 'checks passed'} · ${shortName(report)}${age}`;
  }
  const restack = report.state === 'conflicts' && report.stack.restack ? ' · parent merged' : '';
  return `${restack} · ${shortName(report)}${age}`;
}

export interface Triage {
  needs: PullRequestReport[];
  ready: PullRequestReport[];
  reviewing: PullRequestReport[];
  /** The pull requests merged on the day of `now`, among the ones the relay still lists. */
  mergedToday: number;
}

/** Puts each pull request of the list in its group, in the order of the relay. */
export function triage(reports: readonly PullRequestReport[], now: Date): Triage {
  const out: Triage = { needs: [], ready: [], reviewing: [], mergedToday: 0 };
  for (const report of reports) {
    const group = groupOf(report);
    if (group) out[group].push(report);
    else if (report.mergedAt && sameDay(new Date(report.mergedAt), now)) out.mergedToday++;
  }
  return out;
}
