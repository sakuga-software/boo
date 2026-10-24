import { activeBots, plannedRetries } from './bots.js';
import { decide, quotaScope, quotaSignals, type Decision, type QuotaSignal } from './decide.js';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import { confidenceOf, isOnHead, summarize, type Overall, type Summary } from './reviewers.js';
import type { MergePolicy, PolicyMiss } from './policy.js';
import type { Owner } from './sessions.js';
import type { Settings } from './settings.js';
import { placeStacks } from './stacks.js';

export const keyOf = (pr: PullRequest) => `${pr.repo}#${pr.number}`;

export const OVERALL_LABELS: Record<Overall, string> = {
  conflicts: 'conflicts',
  'changes requested': 'changes requested',
  'checks failing': 'checks failing',
  ready: 'ready to merge',
  approved: 'approved',
  reviewing: 'reviewing',
  reviewed: 'reviewed',
  quota: 'quota',
  'awaiting review': 'awaiting review',
};

// GitHub mergeable_state values that deserve a warning before a merge.
export const MERGE_STATE_WARNINGS: Record<string, string> = {
  dirty: 'conflicts with the base branch',
  blocked: 'blocked by the branch protection rules',
  behind: 'behind the base branch',
  unknown: 'GitHub has not computed the merge state yet',
};

export type Fetched = Omit<PullRequestSnapshot, 'status'>;

/**
 * Gives the CodeRabbit decision and the summary of each open pull request. The CodeRabbit quota
 * belongs to the developer, so each pull request reads the quota signals of all the pull requests in
 * its quota scope (see quotaScope), also the ones that left the list.
 */
export function assess(
  fetched: ReadonlyMap<string, { repo: string; fetched: Fetched; left: boolean }>,
  now: Date,
  { policy, viewer }: { policy?: MergePolicy | undefined; viewer?: string | undefined } = {},
): Map<string, { decision: Decision; summary: Summary }> {
  const scopeOf = ({ repo, fetched }: { repo: string; fetched: Fetched }) =>
    quotaScope(repo, fetched.comments, fetched.reviews);
  const signalsByScope = new Map<string, QuotaSignal[]>();
  for (const [key, entry] of fetched) {
    const scope = scopeOf(entry);
    signalsByScope.set(scope, [
      ...(signalsByScope.get(scope) ?? []),
      ...quotaSignals(key, entry.fetched.comments, entry.fetched.reviews),
    ]);
  }
  const results = new Map<string, { decision: Decision; summary: Summary }>();
  for (const [key, entry] of fetched) {
    if (entry.left) continue;
    const quota = signalsByScope.get(scopeOf(entry)) ?? [];
    const decision = decide({ ...entry.fetched, now, pr: key, quota });
    results.set(key, { decision, summary: summarize({ ...entry.fetched, now, coderabbit: decision, policy, viewer }) });
  }
  return results;
}

/** A pull request as `boo --json` reads it: open, left the list, or unreadable. */
export interface ReportInput {
  pr: PullRequest;
  snapshot?: PullRequestSnapshot;
  error?: string;
}

export type SessionState = 'working' | 'idle' | 'waiting' | 'none';

/** One pull request in the output of `boo --json`. The keys are stable: a script can rely on them. */
export interface PullRequestReport {
  repo: string;
  number: number;
  title: string;
  url: string;
  headSha: string | null;
  base: string | null;
  isDraft: boolean;
  state: string;
  error: string | null;
  checks: { passed: number; failing: string[]; running: number; skipped: number; quota: number };
  reviewers: {
    login: string;
    mark: string;
    onHead: boolean;
    verdict: string | null;
    score: { score: number; total: number } | null;
    at: string | null;
  }[];
  stack: { parent: string | null; position: number | null; size: number };
  agent: { kind: string | null; session: string | null; sessionState: SessionState; cloudSession: string | null };
  notes: { merge: string | null; retries: { bot: string; at: string }[]; coderabbit: CoderabbitNote | null };
  /** The rules of the merge policy that the pull request misses. */
  policy: PolicyMiss[];
}

export type CoderabbitNote =
  | { kind: 'wait'; availableAt: string; delayGuessed: boolean }
  | { kind: 'trigger'; availableAt: string }
  | { kind: 'pending'; requestedAt: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'paused' }
  | { kind: 'idle' };

function coderabbitNote(decision: Decision): CoderabbitNote | null {
  switch (decision.kind) {
    case 'wait':
      return { kind: 'wait', availableAt: decision.availableAt.toISOString(), delayGuessed: decision.delayGuessed };
    case 'trigger':
      return { kind: 'trigger', availableAt: decision.availableAt.toISOString() };
    case 'pending':
      return { kind: 'pending', requestedAt: decision.requestedAt.toISOString() };
    case 'skipped':
      return { kind: 'skipped', reason: decision.reason };
    case 'paused':
    case 'idle':
      return { kind: decision.kind };
    default:
      return null;
  }
}

// Claude Code reports "shell" while the session runs a command.
function sessionStateOf(status: string): SessionState {
  if (status === 'busy' || status === 'shell') return 'working';
  return status === 'waiting' ? 'waiting' : 'idle';
}

function stateOf(snapshot: PullRequestSnapshot | undefined, summary: Summary | undefined, error: string | undefined) {
  if (error || !snapshot) return 'error';
  return summary ? OVERALL_LABELS[summary.overall] : snapshot.status;
}

const NO_CHECKS = { passed: 0, failing: [], running: 0, skipped: 0, quota: 0 };

/** Builds the output of `boo --json`, in the order of the list: each stacked pull request after its base. */
export function buildReport(
  inputs: readonly ReportInput[],
  owners: ReadonlyMap<string, Owner>,
  settings: Settings,
  now: Date,
  viewer?: string,
): PullRequestReport[] {
  const fetched = new Map(
    inputs.flatMap(({ pr, snapshot }) => {
      if (!snapshot) return [];
      const { status, ...rest } = snapshot;
      return [[keyOf(pr), { repo: pr.repo, fetched: rest, left: status !== 'open' }] as const];
    }),
  );
  const assessed = assess(fetched, now, { policy: settings.mergePolicy, viewer });
  const byKey = new Map(inputs.map((input) => [keyOf(input.pr), input]));
  const places = placeStacks(
    inputs.map(({ pr, snapshot }) => ({
      key: keyOf(pr),
      repo: pr.repo,
      branch: snapshot?.branch,
      fork: snapshot?.fork,
      base: snapshot?.base,
      defaultBranch: snapshot?.defaultBranch,
      left: Boolean(snapshot && snapshot.status !== 'open'),
    })),
  );

  return places.map((place) => {
    const { pr, snapshot, error } = byKey.get(place.key)!;
    const result = assessed.get(place.key);
    const summary = result?.summary;
    const confidence = snapshot ? confidenceOf(snapshot.reviews, snapshot.comments) : new Map();
    const session = owners.get(place.key)?.session;
    const agent = snapshot?.agent;
    return {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headSha: snapshot?.head ?? null,
      base: snapshot?.base ?? null,
      isDraft: snapshot?.status === 'draft',
      state: stateOf(snapshot, summary, error),
      error: error ?? null,
      checks: summary
        ? {
            passed: summary.checks.passed,
            failing: summary.checks.failed,
            running: summary.checks.pending,
            skipped: summary.checks.skipped,
            quota: summary.checks.quota,
          }
        : NO_CHECKS,
      reviewers: (summary?.reviewers ?? []).map((reviewer) => ({
        login: reviewer.login,
        mark: reviewer.status,
        onHead: isOnHead(reviewer),
        verdict: reviewer.verdict ?? null,
        score: confidence.get(reviewer.login) ?? null,
        at: reviewer.lastReviewAt?.toISOString() ?? null,
      })),
      stack: { parent: place.parent ?? null, position: place.position ?? null, size: place.size },
      agent: {
        // A local session is always Claude Code, whatever agent wrote the pull request.
        kind: session ? 'claude' : (agent?.id ?? null),
        session: session?.name ?? null,
        sessionState: session ? sessionStateOf(session.status) : 'none',
        cloudSession: agent?.cloudSession ?? null,
      },
      notes: {
        merge: summary ? (MERGE_STATE_WARNINGS[snapshot!.mergeState] ?? null) : null,
        retries: summary
          ? plannedRetries(summary.reviewers, activeBots(settings), settings).map(({ bot, at }) => ({
              bot: bot.name,
              at: at.toISOString(),
            }))
          : [],
        coderabbit: result ? coderabbitNote(result.decision) : null,
      },
      policy: summary?.policy ?? [],
    };
  });
}
