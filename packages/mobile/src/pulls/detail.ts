import { agentName } from '@sakuga-software/boo-core/agents';
import type { CoderabbitNote, PullRequestReport } from '@sakuga-software/boo-core/report';
import { displayName, type ReviewerStatus } from '@sakuga-software/boo-core/reviewers';
import { REVIEWER_MARKS, type Tone } from '@sakuga-software/boo-core/theme';
import { formatAgo, formatDuration, formatTime } from '../ui/time';
import { reportKey } from './view';

// The sections and the words of an unfolded row of the list of boo in the terminal
// (`detailLines` in packages/cli/src/app.tsx), for a report of the relay.

/** A piece of a line, with its tone. `dim`: the terminal shows it dimmed. */
export interface Segment {
  text: string;
  tone?: Tone;
  dim?: boolean;
  bold?: boolean;
}

export type Line = Segment[];

export interface Section {
  label: string;
  lines: Line[];
}

const dim = (text: string): Segment => ({ text, dim: true });

/** The time of the head commit: the relay computed `idleMinutes` at `at`. */
const headAt = (report: PullRequestReport, at: Date) =>
  report.idleMinutes === null ? undefined : new Date(at.getTime() - report.idleMinutes * 60_000);

function changesSection(report: PullRequestReport, at: Date, now: Date): Line[] {
  // A relay older than the key `changes` does not give it.
  const changes = report.changes ?? null;
  const head = headAt(report, at);
  if (!changes) return head ? [[dim(`last commit ${formatAgo(now, head)}`)]] : [];
  const files = `${changes.files} file${changes.files === 1 ? '' : 's'}`;
  return [
    [
      { text: `+${changes.additions}`, tone: 'green' },
      { text: ' ' },
      { text: `−${changes.deletions}`, tone: 'red' },
      dim(` · ${files}${head ? ` · last commit ${formatAgo(now, head)}` : ''}`),
    ],
  ];
}

function agentSection({ agent }: PullRequestReport): Line[] {
  if (!agent.kind) return [];
  const claude = agent.kind === 'claude';
  const name: Segment = { text: `${claude ? '✻' : '◇'} ${agentName(agent.kind)}`, bold: true, tone: 'gray' };
  // The relay knows no session of a computer: only a cloud session that the pull request links.
  if (agent.cloudSession) return [[name, dim(' · cloud session')], [dim(agent.cloudSession)]];
  return [[name]];
}

function reviewerState(reviewer: PullRequestReport['reviewers'][number]): string {
  switch (reviewer.mark) {
    case 'quota':
      return 'out of quota';
    case 'stale':
      return reviewer.verdict && reviewer.verdict !== 'commented'
        ? `an older commit only, ${reviewer.verdict} still stands`
        : 'an older commit only';
    default:
      return reviewer.mark;
  }
}

/** The tone of a confidence score, as `confidenceColor` of the terminal. */
export function scoreTone({ score, total }: { score: number; total: number }): Tone {
  if (score / total >= 0.8) return 'green';
  return score / total >= 0.6 ? 'yellow' : 'red';
}

function reviewersSection({ reviewers }: PullRequestReport, now: Date): Line[] {
  const onHead = reviewers.filter((reviewer) => reviewer.onHead).length;
  // Hermes, the engine of the app, has no `toSorted`: the newest review comes from a loop.
  let last: (typeof reviewers)[number] | undefined;
  for (const reviewer of reviewers)
    if (reviewer.at && (!last || Date.parse(reviewer.at) > Date.parse(last.at!))) last = reviewer;
  let lastText = reviewers.length === 0 ? 'no reviewer yet' : 'no review yet';
  if (last) lastText = `last ${displayName(last.login)} ${formatAgo(now, new Date(last.at!))}`;
  const header = [reviewers.length > 0 && `${onHead}/${reviewers.length} on head`, lastText].filter(Boolean);
  const lines: Line[] = [[dim(header.join(' · '))]];
  for (const reviewer of reviewers) {
    const mark = REVIEWER_MARKS[reviewer.mark as ReviewerStatus] ?? { mark: '?', tone: 'gray' };
    const line: Line = [
      { text: mark.mark, tone: mark.tone },
      { text: ` ${displayName(reviewer.login)}  ` },
      { text: reviewerState(reviewer), tone: mark.tone },
    ];
    if (reviewer.score)
      line.push(dim(' · confidence '), {
        text: `${reviewer.score.score}/${reviewer.score.total}`,
        tone: scoreTone(reviewer.score),
      });
    if (reviewer.at) line.push(dim(` · ${formatAgo(now, new Date(reviewer.at))}`));
    lines.push(line);
  }
  return lines;
}

function checksSection({ checks }: PullRequestReport): Line[] {
  const reviewerErrors = new Set(checks.reviewerErrors.map(({ check }) => check));
  const failed = checks.failing.filter((name) => !reviewerErrors.has(name));
  const counts: Segment[] = [];
  const count = (text: string, tone: Tone) =>
    counts.push({ text: `${counts.length > 0 ? '   ' : ''}${text}`, tone, dim: tone === 'gray' });
  if (checks.passed > 0) count(`✔ ${checks.passed} passed`, 'green');
  if (failed.length > 0) count(`✖ ${failed.length} failing`, 'red');
  if (reviewerErrors.size > 0) count(`⚠ ${reviewerErrors.size} reviewer error`, 'yellow');
  if (checks.running > 0) count(`◌ ${checks.running} running`, 'yellow');
  if (checks.skipped > 0) count(`⊘ ${checks.skipped} skipped`, 'gray');
  if (checks.quota > 0) count(`◷ ${checks.quota} quota only`, 'gray');
  if (counts.length === 0) return [[dim('no checks')]];
  return [
    counts,
    ...failed.map((name): Line => [{ text: `✖ ${name}`, tone: 'red' }]),
    ...checks.reviewerErrors.map(({ check, error }): Line => [
      { text: `⚠ ${check}`, tone: 'yellow' },
      dim(` · the review bot failed, not the change${error ? `: ${error}` : ''}`),
    ]),
  ];
}

/** The CodeRabbit note, as `coderabbitDetail` of the terminal. The relay posts no retry. */
export function coderabbitNote(note: CoderabbitNote | null, now: Date): string | undefined {
  switch (note?.kind) {
    case 'wait': {
      const at = new Date(note.availableAt);
      const remaining = at.getTime() - now.getTime();
      const when = remaining > 0 ? `in ${formatDuration(remaining)}` : 'now';
      const guess = note.delayGuessed ? ' · unreadable delay, 1 h assumed' : '';
      return `CodeRabbit quota back ${when} (at ${formatTime(at)})${guess}`;
    }
    case 'trigger':
      return `CodeRabbit quota back for ${formatDuration(now.getTime() - Date.parse(note.availableAt))}`;
    case 'pending':
      return `CodeRabbit asked at ${formatTime(new Date(note.requestedAt))}, no reply yet`;
    case 'skipped':
      return `CodeRabbit skipped the review: ${note.reason}`;
    case 'paused':
      return 'CodeRabbit reviews are paused';
    case 'idle':
      return 'CodeRabbit: the last commit has no review';
    default:
      return undefined;
  }
}

function notesSection(report: PullRequestReport, reports: readonly PullRequestReport[], at: Date, now: Date) {
  const head = headAt(report, at);
  const parent = report.stack.parent;
  const parentReport = parent ? reports.find((other) => reportKey(other) === parent) : undefined;
  const parentName = parent && parent.slice(parent.lastIndexOf('/') + 1);
  const stale = report.stale;
  const notes = [
    stale &&
      `stale: the state of ${formatTime(new Date(stale.at))}. GitHub refuses the queries (rate limit)${
        stale.until ? `, GitHub answers again at ${formatTime(new Date(stale.until))}` : ''
      }`,
    report.error,
    report.draftState && `draft: ${report.draftState} once ready for review`,
    ...report.policy.map(({ note }) => `merge policy: ${note}`),
    report.stalled && head && `stalled: it needs work, and the last commit is ${formatAgo(now, head)}`,
    parent && `stacked on ${parentName}${parentReport ? ` (${parentReport.state})` : ''}: merge it first`,
    report.stack.restack &&
      `rebase on ${report.base}: its parent on ${report.stack.restack.oldBase} merged, and its commits are still here`,
    report.notes.merge,
    ...report.notes.retries.map(({ bot, at: retryAt }) => `${bot} retry at ${formatTime(new Date(retryAt))}`),
    coderabbitNote(report.notes.coderabbit, now),
  ];
  return notes.filter((note): note is string => Boolean(note)).map((note): Line => [dim(note)]);
}

/**
 * The sections of the details of a pull request: the change, the merge, the agent, the reviewers,
 * the checks, then the notes. `at` is the time of the list of the relay; `reports`, the whole list,
 * gives the state of the parent in a stack.
 */
export function detailSections(
  report: PullRequestReport,
  reports: readonly PullRequestReport[],
  at: Date,
  now: Date,
): Section[] {
  const left = ['merged', 'closed'].includes(report.state);
  const merged: Line[] = report.mergedAt
    ? [
        [
          dim(
            `${report.mergedBy ? `by ${report.mergedBy}` : 'by an unknown account'} · ${formatAgo(now, new Date(report.mergedAt))}`,
          ),
        ],
      ]
    : [];
  const sections: Section[] = [
    { label: 'changes', lines: changesSection(report, at, now) },
    { label: 'merged', lines: merged },
    { label: 'agent', lines: agentSection(report) },
    { label: 'reviewers', lines: left || report.error ? [] : reviewersSection(report, now) },
    { label: 'checks', lines: left || report.error ? [] : checksSection(report) },
    { label: 'notes', lines: notesSection(report, reports, at, now) },
  ];
  return sections.filter((section) => section.lines.length > 0);
}
