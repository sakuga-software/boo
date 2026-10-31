/**
 * A change that the relay sends to the watches. `data` holds the fields of the delivery that the
 * watch needs to update its row with no read of GitHub. The values are the ones of the webhook, for
 * example a check `conclusion` in lower case: the watch maps them to its own states.
 */
export interface RelayChange {
  /** The webhook event, for example `pull_request` or `check_run`. */
  type: string;
  action?: string;
  /** The full name of the repository, `owner/name`. */
  repo: string;
  /** The number of the pull request, if GitHub gives it. */
  number?: number;
  /**
   * The head commit, if GitHub gives no pull request number. A `status` gives only a commit, and a
   * check of a pull request from a fork has no pull request in its payload.
   */
  sha?: string;
  data?: ChangeData;
}

export type ChangeData =
  | { pullRequest: PullRequestData }
  | { review: ReviewData }
  | { comment: CommentData }
  | { thread: ThreadData }
  | { checkRun: CheckRunData }
  | { checkSuite: CheckSuiteData }
  | { status: StatusData }
  | { workflowRun: WorkflowRunData };

export interface PullRequestData {
  title?: string;
  body?: string;
  /** `open` or `closed`. */
  state?: string;
  draft?: boolean;
  merged?: boolean;
  mergedAt?: string;
  mergedBy?: string;
  author?: string;
  headSha?: string;
  headRef?: string;
  /** True if the head branch is in another repository than the base. */
  fork?: boolean;
  baseRef?: string;
  defaultBranch?: string;
  /** GitHub often leaves it out of a webhook: it computes it after the delivery. */
  mergeableState?: string;
  /** The logins and the team slugs that GitHub still asks for a review. */
  requested?: string[];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  updatedAt?: string;
}

export interface ReviewData {
  id?: number;
  author?: string;
  /** `approved`, `changes_requested`, `commented` or `dismissed`. */
  state?: string;
  body?: string;
  commitId?: string;
  submittedAt?: string;
}

export interface CommentData {
  id?: number;
  author?: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  /** A line comment only: the comment that it answers. */
  inReplyTo?: number;
  /** A line comment only: its review. */
  reviewId?: number;
  path?: string;
}

export interface ThreadData {
  resolved: boolean;
  comments: { id?: number; author?: string; body?: string }[];
}

export interface CheckRunData {
  id?: number;
  name?: string;
  /** `queued`, `in_progress` or `completed`. */
  status?: string;
  /** `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`, or absent. */
  conclusion?: string;
  headSha?: string;
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
  suiteId?: number;
  /** The slug of the App that runs the check, for example `github-actions`. */
  app?: string;
}

export interface CheckSuiteData {
  id?: number;
  status?: string;
  conclusion?: string;
  headSha?: string;
  app?: string;
}

export interface StatusData {
  context?: string;
  /** `pending`, `success`, `failure` or `error`. */
  state?: string;
  description?: string;
  targetUrl?: string;
}

export interface WorkflowRunData {
  id?: number;
  /** The name of the workflow. */
  name?: string;
  workflowId?: number;
  status?: string;
  conclusion?: string;
  headSha?: string;
  event?: string;
  attempt?: number;
}

type Payload = Record<string, unknown>;

const record = (value: unknown): Payload | undefined =>
  value && typeof value === 'object' ? (value as Payload) : undefined;
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const count = (value: unknown) => (typeof value === 'number' ? value : undefined);
const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
const login = (value: unknown) => text(record(value)?.login);

/** Removes the fields that GitHub did not give, so that an event carries no `undefined`. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

const pullNumbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.map((pull) => count(record(pull)?.number)).filter((n) => n !== undefined) : [];

function pullRequestData(pull: Payload, repository: Payload | undefined): PullRequestData {
  const head = record(pull.head);
  const base = record(pull.base);
  const headRepo = text(record(head?.repo)?.full_name);
  const baseRepo = text(record(base?.repo)?.full_name);
  const reviewers = Array.isArray(pull.requested_reviewers) ? pull.requested_reviewers.map(login) : [];
  const teams = Array.isArray(pull.requested_teams) ? pull.requested_teams.map((team) => text(record(team)?.slug)) : [];
  return compact({
    title: text(pull.title),
    body: text(pull.body),
    state: text(pull.state),
    draft: flag(pull.draft),
    merged: flag(pull.merged),
    mergedAt: text(pull.merged_at),
    mergedBy: login(pull.merged_by),
    author: login(pull.user),
    headSha: text(head?.sha),
    headRef: text(head?.ref),
    fork: headRepo && baseRepo ? headRepo !== baseRepo : undefined,
    baseRef: text(base?.ref),
    defaultBranch: text(repository?.default_branch),
    mergeableState: text(pull.mergeable_state),
    requested: [...reviewers, ...teams].filter((name) => name !== undefined),
    additions: count(pull.additions),
    deletions: count(pull.deletions),
    changedFiles: count(pull.changed_files),
    updatedAt: text(pull.updated_at),
  });
}

const reviewData = (review: Payload): ReviewData =>
  compact({
    id: count(review.id),
    author: login(review.user),
    state: text(review.state)?.toLowerCase(),
    body: text(review.body),
    commitId: text(review.commit_id),
    submittedAt: text(review.submitted_at),
  });

const commentData = (comment: Payload): CommentData =>
  compact({
    id: count(comment.id),
    author: login(comment.user),
    body: text(comment.body),
    createdAt: text(comment.created_at),
    updatedAt: text(comment.updated_at),
    inReplyTo: count(comment.in_reply_to_id),
    reviewId: count(comment.pull_request_review_id),
    path: text(comment.path),
  });

function threadData(thread: Payload, action: string | undefined): ThreadData {
  const comments = Array.isArray(thread.comments) ? thread.comments : [];
  return {
    resolved: action === 'resolved',
    comments: comments.map((comment) => {
      const fields = record(comment) ?? {};
      return compact({ id: count(fields.id), author: login(fields.user), body: text(fields.body) });
    }),
  };
}

const checkRunData = (run: Payload): CheckRunData =>
  compact({
    id: count(run.id),
    name: text(run.name),
    status: text(run.status),
    conclusion: text(run.conclusion),
    headSha: text(run.head_sha),
    startedAt: text(run.started_at),
    completedAt: text(run.completed_at),
    detailsUrl: text(run.details_url),
    suiteId: count(record(run.check_suite)?.id),
    app: text(record(run.app)?.slug),
  });

const checkSuiteData = (suite: Payload): CheckSuiteData =>
  compact({
    id: count(suite.id),
    status: text(suite.status),
    conclusion: text(suite.conclusion),
    headSha: text(suite.head_sha),
    app: text(record(suite.app)?.slug),
  });

const statusData = (payload: Payload): StatusData =>
  compact({
    context: text(payload.context),
    state: text(payload.state),
    description: text(payload.description),
    targetUrl: text(payload.target_url),
  });

const workflowRunData = (run: Payload): WorkflowRunData =>
  compact({
    id: count(run.id),
    name: text(run.name),
    workflowId: count(run.workflow_id),
    status: text(run.status),
    conclusion: text(run.conclusion),
    headSha: text(run.head_sha),
    event: text(run.event),
    attempt: count(run.run_attempt),
  });

/** The changes of a webhook delivery. A delivery that concerns no pull request gives none. */
export function changesOf(type: string, payload: Payload): RelayChange[] {
  const repository = record(payload.repository);
  const repo = text(repository?.full_name);
  if (!repo) return [];
  const action = text(payload.action);
  const base = { type, repo, ...(action && { action }) };
  const numbered = (number: number | undefined, data: ChangeData): RelayChange[] =>
    number === undefined ? [] : [{ ...base, number, data }];
  const forPulls = (pulls: unknown, sha: unknown, data: ChangeData): RelayChange[] => {
    const numbers = pullNumbers(pulls);
    if (numbers.length > 0) return numbers.map((number) => ({ ...base, number, data }));
    const head = text(sha);
    return head ? [{ ...base, sha: head, data }] : [];
  };
  const pull = record(payload.pull_request) ?? {};
  switch (type) {
    case 'pull_request':
      return numbered(count(payload.number), { pullRequest: pullRequestData(pull, repository) });
    case 'pull_request_review':
      return numbered(count(pull.number), { review: reviewData(record(payload.review) ?? {}) });
    case 'pull_request_review_comment':
      return numbered(count(pull.number), { comment: commentData(record(payload.comment) ?? {}) });
    case 'pull_request_review_thread':
      return numbered(count(pull.number), { thread: threadData(record(payload.thread) ?? {}, action) });
    case 'issue_comment': {
      const issue = record(payload.issue);
      return issue?.pull_request
        ? numbered(count(issue.number), { comment: commentData(record(payload.comment) ?? {}) })
        : [];
    }
    case 'check_run': {
      const run = record(payload.check_run) ?? {};
      return forPulls(run.pull_requests, run.head_sha, { checkRun: checkRunData(run) });
    }
    case 'check_suite': {
      const suite = record(payload.check_suite) ?? {};
      return forPulls(suite.pull_requests, suite.head_sha, { checkSuite: checkSuiteData(suite) });
    }
    case 'workflow_run': {
      const run = record(payload.workflow_run) ?? {};
      return forPulls(run.pull_requests, run.head_sha, { workflowRun: workflowRunData(run) });
    }
    case 'status':
      return forPulls(undefined, payload.sha, { status: statusData(payload) });
    default:
      return [];
  }
}

/**
 * The webhook events that can change the repositories that a user reads through the App: an
 * installation, its repositories, a collaborator, a member of an organization, a repository that
 * moves or changes its visibility.
 */
const ACCESS_EVENTS = new Set([
  'installation',
  'installation_repositories',
  'member',
  'membership',
  'organization',
  'repository',
]);

export const changesAccess = (type: string) => ACCESS_EVENTS.has(type);
