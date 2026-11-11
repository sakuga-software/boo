import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { displayName } from '@sakuga-software/boo-core/reviewers';
import { bestScore, failedChecks } from './triage';

/** A line of the merge sheet: a rule, whether the pull request passes it, and its value. */
export interface MergeRule {
  label: string;
  ok: boolean;
  value: string;
  score?: { score: number; total: number };
  /** The login of the first account that approved, for its avatar. */
  approver?: string;
}

/** The rules that the merge sheet lists, from the report of the relay. */
export function mergeRules(report: PullRequestReport): MergeRule[] {
  const { checks } = report;
  const counted = checks.passed + checks.failing.length + checks.running;
  const rules: MergeRule[] = [
    {
      label: 'Checks passed',
      ok: failedChecks(checks).length === 0 && checks.running === 0,
      value: counted > 0 ? `${checks.passed}/${counted}` : 'no checks',
    },
  ];
  const score = bestScore(report.reviewers);
  const scoreMiss = report.policy.find(({ rule }) => rule === 'minScore');
  if (score || scoreMiss)
    rules.push({
      label: 'Review score',
      ok: !scoreMiss,
      value: score ? `${score.score}/${score.total}` : 'none',
      ...(score && { score }),
    });
  if (report.threads) {
    const total = report.threads.open + report.threads.answered;
    rules.push({
      label: 'Bot threads answered',
      ok: report.threads.open === 0,
      value: `${report.threads.answered}/${total}`,
    });
  }
  const approvers = report.reviewers.filter(({ verdict, mark }) => mark === 'approved' || verdict === 'approved');
  rules.push({
    label: 'Approved',
    ok: approvers.length > 0,
    value:
      approvers.length > 0
        ? approvers.map(({ login }) => `${displayName(login)}${login.endsWith('[bot]') ? ' · bot' : ''}`).join(', ')
        : 'nobody yet',
    ...(approvers[0] && { approver: approvers[0].login }),
  });
  rules.push({ label: `No conflicts with ${report.base ?? 'the base'}`, ok: report.state !== 'conflicts', value: '' });
  for (const { rule, note } of report.policy)
    if (rule !== 'minScore') rules.push({ label: note.charAt(0).toUpperCase() + note.slice(1), ok: false, value: '' });
  return rules;
}
