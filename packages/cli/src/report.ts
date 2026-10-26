import { activeBots, plannedRetries } from './bots.js';
import { decide, quotaScope, quotaSignals, type Decision, type QuotaSignal } from './decide.js';
import type { PullRequest, PullRequestSnapshot } from './github.js';
import { confidenceOf, isOnHead, summarize, type Overall, type Summary } from './reviewers.js';
import type { MergePolicy, PolicyMiss } from './policy.js';
import { isWorkingStatus, ownerWorks, type Owner, type SubAgentState } from './sessions.js';
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

// The states that need somebody to act on the pull request.
const STALLING: ReadonlySet<Overall> = new Set(['conflicts', 'checks failing', 'changes requested']);

/**
 * A pull request is stalled if it needs work (conflicts, checks failing or changes requested), no local
 * session works on it, and its head commit is older than `afterMinutes`. A session that waits for an
 * answer does not work. `idleMinutes` is the age of the head commit.
 */
export function stallOf({
  overall,
  headAt,
  working,
  afterMinutes,
  now,
}: {
  overall: Overall | undefined;
  headAt: string | undefined;
  working: boolean;
  afterMinutes: number;
  now: Date;
}): { stalled: boolean; idleMinutes: number | null } {
  if (!headAt) return { stalled: false, idleMinutes: null };
  const idleMinutes = Math.max(0, Math.floor((now.getTime() - new Date(headAt).getTime()) / 60_000));
  const stalled = overall !== undefined && STALLING.has(overall) && !working && idleMinutes >= afterMinutes;
  return { stalled, idleMinutes };
}

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
  /** Red, with no working session and no new commit for `stalledAfterMinutes`. */
  stalled: boolean;
  /** The minutes since the commit time of the head commit. */
  idleMinutes: number | null;
  /** The login that merged the pull request, and when. Null if it is not merged. */
  mergedBy: string | null;
  mergedAt: string | null;
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
  stack: {
    parent: string | null;
    position: number | null;
    size: number;
    /** The old base, if GitHub moved the pull request after its parent merged and no commit came since. */
    restack: { oldBase: string; at: string } | null;
  };
  agent: {
    kind: string | null;
    session: string | null;
    subAgent: { id: string; description: string | null; state: SubAgentState; error: string | null } | null;
    sessionState: SessionState;
    cloudSession: string | null;
  };
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

function sessionStateOf(status: string): SessionState {
  if (isWorkingStatus(status)) return 'working';
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
    const owner = owners.get(place.key);
    const session = owner?.session;
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
      ...stallOf({
        overall: summary?.overall,
        headAt: snapshot?.headAt,
        working: Boolean(owner && ownerWorks(owner)),
        afterMinutes: settings.stalledAfterMinutes,
        now,
      }),
      mergedBy: snapshot?.mergedBy ?? null,
      mergedAt: snapshot?.mergedAt ?? null,
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
      stack: {
        parent: place.parent ?? null,
        position: place.position ?? null,
        size: place.size,
        restack: snapshot?.restack ?? null,
      },
      agent: {
        // A local session is always Claude Code, whatever agent wrote the pull request.
        kind: session ? 'claude' : (agent?.id ?? null),
        session: session?.name ?? null,
        subAgent: owner?.subAgent
          ? {
              id: owner.subAgent.id,
              description: owner.subAgent.description ?? null,
              state: owner.subAgent.state,
              error: owner.subAgent.error ?? null,
            }
          : null,
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
