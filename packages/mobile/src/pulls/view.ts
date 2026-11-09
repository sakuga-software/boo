import { agentName } from '@sakuga-software/boo-core/agents';
import { OVERALL_LABELS, type PullRequestReport } from '@sakuga-software/boo-core/report';
import { displayName, type Overall, type ReviewerStatus } from '@sakuga-software/boo-core/reviewers';
import {
  ERROR_MARK,
  LEFT_MARKS,
  OVERALL_MARKS,
  REVIEWER_MARKS,
  type Mark,
  type Tone,
} from '@sakuga-software/boo-core/theme';

// The words, the marks and the tones are the ones of the list of boo in the terminal (packages/cli/src/app.tsx).

/** The state of a pull request on its row. `spins`: the terminal turns a spinner in place of the mark. */
export interface StateView extends Mark {
  label: string;
  spins: boolean;
  /** The report is the last read that worked, not the state of now. */
  stale: boolean;
}

const OVERALL_OF_LABEL = new Map(
  (Object.entries(OVERALL_LABELS) as [Overall, string][]).map(([overall, label]) => [label, overall]),
);
const UNKNOWN: Mark = { mark: '?', tone: 'gray' };

function otherMark(state: string): Mark {
  if (state === 'error') return ERROR_MARK;
  return (LEFT_MARKS[state as keyof typeof LEFT_MARKS] as Mark | undefined) ?? UNKNOWN;
}

/** The mark and the tone of the `state` of a report: a label of `OVERALL_LABELS`, `error`, or a status of GitHub. */
export function stateView(report: Pick<PullRequestReport, 'state' | 'stale'>): StateView {
  const overall = OVERALL_OF_LABEL.get(report.state);
  const mark = overall ? OVERALL_MARKS[overall] : otherMark(report.state);
  return { ...mark, label: report.state, spins: overall === 'reviewing', stale: report.stale !== null };
}

/** A count on a row, with its tone. `dim`: the terminal shows it dimmed. */
export interface Badge {
  text: string;
  tone: Tone;
  dim?: boolean;
}

/** The badge of the checks on a row, as `ChecksBadge` of the terminal. */
export function checksBadge(checks: PullRequestReport['checks']): Badge {
  // `failing` also holds the red reviewer checks.
  const reviewerErrors = checks.reviewerErrors.length;
  const failed = checks.failing.length - reviewerErrors;
  const counted = checks.passed + checks.failing.length + checks.running;
  if (failed > 0) return { text: `✖ ${failed}/${counted} failing`, tone: 'red' };
  if (reviewerErrors > 0) return { text: `⚠ ${reviewerErrors}/${counted} reviewer error`, tone: 'yellow' };
  if (checks.running > 0) return { text: `◌ ${checks.running}/${counted} running`, tone: 'yellow' };
  if (counted === 0) {
    if (checks.skipped > 0) return { text: `⊘ ${checks.skipped} skipped`, tone: 'gray', dim: true };
    if (checks.quota > 0) return { text: `◷ ${checks.quota} quota only`, tone: 'gray', dim: true };
    return { text: 'no checks', tone: 'gray', dim: true };
  }
  return { text: `✔ ${checks.passed}/${counted} checks`, tone: 'green' };
}

/** The place of the pull request in its stack, as `stackHint` of the terminal. */
export function stackHint(stack: PullRequestReport['stack']): string | undefined {
  if (stack.restack) return 'parent merged · rebase';
  if (stack.parent) {
    // The key of the parent is `owner/name#number`.
    const number = stack.parent.slice(stack.parent.lastIndexOf('#') + 1);
    return `on #${number}${stack.position ? ` · ${stack.position}/${stack.size}` : ''}`;
  }
  return stack.size > 1 ? `stack of ${stack.size}` : undefined;
}

/** The agent on a row: its mark, and its name. The relay knows no local session: only the pull request names it. */
export interface AgentBadge {
  mark: string;
  name: string;
  claude: boolean;
}

export function agentBadge(agent: PullRequestReport['agent']): AgentBadge | undefined {
  if (!agent.kind) return undefined;
  const claude = agent.kind === 'claude';
  let name = claude ? 'Claude' : agentName(agent.kind);
  if (agent.cloudSession) name = 'cloud';
  return { mark: claude ? '✻' : '◇', name, claude };
}

/** A reviewer on a row: the mark of its status, and its name. */
export interface ReviewerChip extends Mark {
  name: string;
}

export const reviewerChips = (reviewers: PullRequestReport['reviewers']): ReviewerChip[] =>
  reviewers.map((reviewer) => ({
    ...(REVIEWER_MARKS[reviewer.mark as ReviewerStatus] ?? UNKNOWN),
    name: displayName(reviewer.login),
  }));

/** The key of a row: `owner/name#number`, as `keyOf` of core. */
export const reportKey = (report: Pick<PullRequestReport, 'repo' | 'number'>) => `${report.repo}#${report.number}`;
