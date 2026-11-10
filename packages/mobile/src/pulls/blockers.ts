import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { displayName } from '@sakuga-software/boo-core/reviewers';
import type { Tone } from '@sakuga-software/boo-core/theme';
import type { IconName } from '../ui/icons';
import { formatTime } from '../ui/time';
import { failedChecks } from './triage';

/** Where an action of the details sends the person: the relay cannot act, GitHub can. */
export type Target = 'checks' | 'pull' | 'files';

/** A thing that keeps the pull request from a merge, and the action on GitHub that can end it. */
export interface Blocker {
  icon: IconName;
  /** The tone of the icon. `claude` is the color of the mark of Claude. */
  tone: Tone | 'claude';
  what: string;
  why: string;
  action?: { label: string; icon: IconName; target: Target };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What keeps the pull request from a merge, the most urgent first: the failing checks, the reviews that
 * ask for changes, the conflicts, the agent that stopped, then the rules of the merge policy. A pull
 * request that is ready to merge has none.
 */
export function blockersOf(report: PullRequestReport, reports: readonly PullRequestReport[]): Blocker[] {
  if (report.state === 'merged' || report.state === 'closed') return [];
  const out: Blocker[] = [];
  const rerun = { label: 'Re-run', icon: 'retry', target: 'checks' } as const;
  const open = { label: 'Open', icon: 'external', target: 'pull' } as const;
  if (report.error) out.push({ icon: 'x', tone: 'red', what: 'The relay could not read it', why: report.error });
  for (const name of failedChecks(report.checks))
    out.push({
      icon: 'x',
      tone: 'red',
      what: `${name} fails`,
      why: 'A check of the head commit is red',
      action: rerun,
    });
  for (const { check, error } of report.checks.reviewerErrors)
    out.push({
      icon: 'warn',
      tone: 'yellow',
      what: `${check}: the review bot failed`,
      why: error ?? 'The bot failed, not the change',
      action: rerun,
    });
  for (const reviewer of report.reviewers)
    if (reviewer.mark === 'changes requested')
      out.push({
        icon: 'pencil',
        tone: 'red',
        what: `${displayName(reviewer.login)} requested changes`,
        why: 'Answer the review, then ask again',
        action: open,
      });
  if (report.state === 'conflicts') {
    const restack = report.stack.restack;
    out.push({
      icon: 'warn',
      tone: 'red',
      what: `Conflicts with ${report.base ?? 'the base branch'}`,
      why: restack ? `Its parent on ${restack.oldBase} merged: rebase it` : 'Rebase it, or merge the base branch',
      action: open,
    });
  }
  const sub = report.agent.subAgent;
  if (sub?.state === 'failed' || sub?.state === 'stopped')
    out.push({
      icon: 'claude',
      tone: 'claude',
      what: 'No agent works on it',
      why: `The sub-agent ${sub.state}${sub.error ? `: ${sub.error}` : ''}`,
    });
  else if (report.stalled)
    out.push({ icon: 'zz', tone: 'yellow', what: 'Stalled', why: 'It needs work, and no commit came for a while' });
  for (const { note } of report.policy)
    out.push({ icon: 'gauge', tone: 'yellow', what: capital(note), why: 'A rule of the merge policy', action: open });
  if (report.threads && report.threads.open > 0) {
    const open = report.threads.open;
    out.push({
      icon: 'dot',
      tone: 'cyan',
      what: `${open} bot thread${open === 1 ? '' : 's'} with no answer`,
      why: 'Answer them on GitHub',
      action: { label: 'Open', icon: 'external', target: 'files' },
    });
  }
  const parent = report.stack.parent;
  if (parent) {
    const state = reports.find((other) => `${other.repo}#${other.number}` === parent)?.state;
    if (state !== 'merged')
      out.push({
        icon: 'stack',
        tone: 'magenta',
        what: `Stacked on #${parent.slice(parent.lastIndexOf('#') + 1)}`,
        why: state ? `Merge it first: it is ${state}` : 'Merge it first',
      });
  }
  if (report.needsOwner)
    out.push({
      icon: 'people',
      tone: 'yellow',
      what: `Needs ${report.needsOwner.owner}`,
      why: `${report.needsOwner.paths.length} file${report.needsOwner.paths.length === 1 ? '' : 's'} need their review`,
    });
  if (report.state === 'quota' && report.notes.coderabbit?.kind === 'wait')
    out.push({
      icon: 'quota',
      tone: 'yellow',
      what: 'A reviewer is out of quota',
      why: `It reviews again at ${formatTime(new Date(report.notes.coderabbit.availableAt))}`,
    });
  return out;
}

/** The address on GitHub of a target of an action. */
export function targetUrl(report: Pick<PullRequestReport, 'url'>, target: Target): string {
  if (target === 'checks') return `${report.url}/checks`;
  return target === 'files' ? `${report.url}/files` : report.url;
}

/** The label of the main button of the action bar: the action of the first blocker, with its object. */
export function mainAction(blockers: readonly Blocker[]): (Blocker['action'] & { label: string }) | undefined {
  const first = blockers.find((blocker) => blocker.action);
  if (!first?.action) return undefined;
  const check = first.what.match(/^(.+) fails$/)?.[1];
  return { ...first.action, label: check ? `Re-run ${check}` : `${first.action.label} on GitHub` };
}
