import type { RelayConnection } from '@sakuga-software/boo-core/relay';

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface MergeRequest {
  repo: string;
  number: number;
  method: MergeMethod;
  deleteBranch: boolean;
  /** The head that the person saw: GitHub refuses the merge if a push came after it. */
  sha: string;
}

/** The answer of the relay to a merge. */
export type MergeResult =
  | { status: 'merged'; sha: string; branchDeleted: boolean }
  /** The GitHub App of the relay has no write permission. */
  | { status: 'no-write'; message: string }
  /** GitHub refused the merge: a branch protection, a new push, a pull request that cannot merge. */
  | { status: 'refused'; message: string }
  | { status: 'expired' }
  | { status: 'failed'; message: string };

const TIMEOUT_MS = 30_000;

/**
 * Asks the relay to merge a pull request (`POST /merge`). The relay merges with the GitHub token of
 * the person, so GitHub shows the person as the author of the merge. A redirect could send the session
 * token to another host, so it is refused.
 */
export async function mergePull(
  connection: RelayConnection,
  fetchFn: typeof fetch,
  request: MergeRequest,
  timeoutMs = TIMEOUT_MS,
): Promise<MergeResult> {
  let response: Response;
  try {
    response = await fetchFn(`${connection.url}/merge`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.session}` },
      body: JSON.stringify(request),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      return {
        status: 'failed',
        message: `The relay did not answer in ${timeoutMs / 1000} s. Check the pull request on GitHub.`,
      };
    return { status: 'failed', message: 'The relay did not answer. Try again later.' };
  }
  if (response.status === 401) return { status: 'expired' };
  const body = (await response.json().catch(() => ({}))) as {
    merged?: unknown;
    sha?: unknown;
    branchDeleted?: unknown;
    error?: unknown;
    code?: unknown;
  };
  const message = typeof body.error === 'string' ? body.error : `The relay answered ${response.status}.`;
  if (response.ok && body.merged === true)
    return {
      status: 'merged',
      sha: typeof body.sha === 'string' ? body.sha : '',
      branchDeleted: body.branchDeleted === true,
    };
  if (response.status === 403 && body.code === 'no-write') return { status: 'no-write', message };
  if (response.status === 409) return { status: 'refused', message };
  // A relay older than the merge has no route for it.
  if (response.status === 404 && message === 'not found')
    return { status: 'no-write', message: 'This relay cannot merge: update it.' };
  return { status: 'failed', message };
}

/** The words under the title of a merge that worked: `Squashed · feat/x deleted`. */
export function mergedDetail(method: MergeMethod, branchDeleted: boolean): string {
  const done = { squash: 'Squashed', merge: 'Merge commit', rebase: 'Rebased' }[method];
  return branchDeleted ? `${done} · branch deleted` : done;
}

/**
 * True if the App of the relay can merge in `owner`, from `canMerge` of `GET /installations`.
 * Undefined: the relay does not say, and a merge tries.
 */
export function canMergeIn(
  installations: readonly { account: string; canMerge?: boolean }[] | undefined,
  owner: string,
): boolean | undefined {
  const found = installations?.find(({ account }) => account.toLowerCase() === owner.toLowerCase());
  return found?.canMerge;
}
