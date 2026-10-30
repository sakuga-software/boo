/**
 * A change that the relay sends to the watches. It names the pull request, never its content: the
 * watch reads the pull request again with its own token.
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
}

type Payload = Record<string, unknown>;

const record = (value: unknown): Payload | undefined =>
  value && typeof value === 'object' ? (value as Payload) : undefined;
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const count = (value: unknown) => (typeof value === 'number' ? value : undefined);

const pullNumbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.map((pull) => count(record(pull)?.number)).filter((n) => n !== undefined) : [];

/** The changes of a webhook delivery. A delivery that concerns no pull request gives none. */
export function changesOf(type: string, payload: Payload): RelayChange[] {
  const repo = text(record(payload.repository)?.full_name);
  if (!repo) return [];
  const action = text(payload.action);
  const base = { type, repo, ...(action && { action }) };
  const forPulls = (pulls: unknown, sha: unknown): RelayChange[] => {
    const numbers = pullNumbers(pulls);
    if (numbers.length > 0) return numbers.map((number) => ({ ...base, number }));
    const head = text(sha);
    return head ? [{ ...base, sha: head }] : [];
  };
  switch (type) {
    case 'pull_request':
      return numbered(base, count(payload.number));
    case 'pull_request_review':
    case 'pull_request_review_comment':
    case 'pull_request_review_thread':
      return numbered(base, count(record(payload.pull_request)?.number));
    case 'issue_comment': {
      const issue = record(payload.issue);
      return issue?.pull_request ? numbered(base, count(issue.number)) : [];
    }
    case 'check_suite':
    case 'check_run':
    case 'workflow_run': {
      const run = record(payload[type]);
      return forPulls(run?.pull_requests, run?.head_sha);
    }
    case 'status':
      return forPulls(undefined, payload.sha);
    default:
      return [];
  }
}

const numbered = (base: Omit<RelayChange, 'number'>, number: number | undefined): RelayChange[] =>
  number === undefined ? [] : [{ ...base, number }];

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
