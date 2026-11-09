import { summarizeFindings } from '@sakuga-software/boo-core/findings';
import type { PullRequestReport } from '@sakuga-software/boo-core/report';

/** Only for the tests. A report of `GET /state`: an open pull request, green and approved. */
export function report(patch: Partial<PullRequestReport> = {}): PullRequestReport {
  return {
    repo: 'acme/web',
    number: 12,
    title: 'Show the list',
    url: 'https://github.com/acme/web/pull/12',
    headSha: 'aaa111',
    base: 'main',
    isDraft: false,
    state: 'ready to merge',
    stalled: false,
    idleMinutes: 5,
    mergedBy: null,
    mergedAt: null,
    error: null,
    checks: { passed: 3, failing: [], running: 0, skipped: 0, quota: 0, reviewerErrors: [] },
    reviewers: [
      {
        login: 'kento-review[bot]',
        mark: 'approved',
        onHead: true,
        verdict: 'approved',
        score: { score: 4, total: 5 },
        at: '2026-11-09T11:00:00.000Z',
      },
    ],
    stack: { parent: null, position: null, size: 1, restack: null },
    agent: { kind: null, session: null, subAgent: null, sessionState: 'none', cloudSession: null },
    notes: { merge: null, retries: [], coderabbit: null },
    policy: [],
    stale: null,
    findings: summarizeFindings([]),
    threads: null,
    needsOwner: null,
    readyForOwner: false,
    draftState: null,
    ...patch,
  };
}
