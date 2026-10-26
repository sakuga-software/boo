import { displayName, isBotLogin } from './reviewers.js';
import type { Comment, Review } from './decide.js';

/** The rules that a team adds to "ready to merge", from the `mergePolicy` of the settings file. */
export interface MergePolicy {
  /** The last confidence score of `reviewer` must be at least `score`, from a review of the head commit if `onHead`. */
  minScore?: { reviewer: string; score: number; onHead: boolean };
  /** A regular expression that the description or a comment must match: a link to a recording, or a reason. */
  requireProof?: string;
  /** Every review thread that a bot starts must be resolved. */
  resolvedBotThreads?: boolean;
  /** Only `owner` merges a pull request that changes a file under one of `paths`. `@me` is the user of boo. */
  ownerOnly?: { paths: string[]; owner: string };
  /** A review that a comment asks of a bot after its last review must come before the merge. */
  answeredReviewRequests?: boolean;
}

export type PolicyRule = 'minScore' | 'requireProof' | 'resolvedBotThreads' | 'ownerOnly' | 'answeredReviewRequests';

/** A rule that the pull request misses, with the note that the details and the merge refusal show. */
export interface PolicyMiss {
  rule: PolicyRule;
  note: string;
}

/** The facts of a pull request that the rules read. */
export interface PolicyFacts {
  head: string;
  body: string;
  reviews: readonly Review[];
  comments: readonly Comment[];
  /** The authors of the review threads that are not resolved. */
  openThreads: readonly string[];
  /** The changed files. Undefined if GitHub gave no list. */
  files?: readonly string[] | undefined;
  /** The count of changed files. The list can hold fewer: the query reads the first 100. */
  changedFiles?: number | undefined;
  /** The login of the user of boo, if GitHub gave it. */
  viewer?: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const compiles = (pattern: string) => {
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
};

/** The parts of a pull request that the query reads for the policy: each one costs GraphQL points. */
export const extraFields = (policy: MergePolicy | undefined) => ({
  threads: Boolean(policy?.resolvedBotThreads),
  files: Boolean(policy?.ownerOnly),
});

/** Reads the merge policy from any JSON value. A rule with a missing or invalid field is dropped. */
export function parseMergePolicy(value: unknown): MergePolicy | undefined {
  if (!isRecord(value)) return undefined;
  const policy: MergePolicy = {};
  const { minScore, requireProof, resolvedBotThreads, ownerOnly, answeredReviewRequests } = value;
  if (
    isRecord(minScore) &&
    typeof minScore.reviewer === 'string' &&
    minScore.reviewer.trim() &&
    typeof minScore.score === 'number' &&
    minScore.score > 0
  )
    policy.minScore = { reviewer: minScore.reviewer.trim(), score: minScore.score, onHead: minScore.onHead === true };
  if (typeof requireProof === 'string' && requireProof.trim() && compiles(requireProof))
    policy.requireProof = requireProof;
  if (resolvedBotThreads === true) policy.resolvedBotThreads = true;
  if (isRecord(ownerOnly) && Array.isArray(ownerOnly.paths) && typeof ownerOnly.owner === 'string') {
    const paths = ownerOnly.paths.filter((path): path is string => typeof path === 'string' && Boolean(path.trim()));
    if (paths.length > 0 && ownerOnly.owner.trim()) policy.ownerOnly = { paths, owner: ownerOnly.owner.trim() };
  }
  if (answeredReviewRequests === true) policy.answeredReviewRequests = true;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/**
 * Turns a glob into a regular expression:
 * - `**` matches any part of a path, slashes included, and `**\/` also matches no folder;
 * - `*` matches any part of one file or folder name;
 * - `?` matches one character of a name.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const sameLogin = (a: string, b: string) =>
  a.replace(/\[bot\]$/, '').toLowerCase() === b.replace(/\[bot\]$/, '').toLowerCase();

// Greptile writes "Confidence Score: 4/5", and Sakuga Review writes "Score de confiance : 4/5".
const CONFIDENCE = /(?:confidence score|score de confiance)\W{0,6}(\d{1,2})\s*\/\s*(\d{1,2})/i;

/** The last score of the reviewer, and the commit of its review. A comment has no commit. */
function lastScore(
  reviewer: string,
  facts: PolicyFacts,
): { score: number; total: number; commit?: string } | undefined {
  const posts = [
    ...facts.reviews.map((review) => ({
      login: review.user?.login,
      body: review.body ?? '',
      at: review.submitted_at,
      commit: review.commit_id,
    })),
    ...facts.comments.map((comment) => ({
      login: comment.user?.login,
      body: comment.body,
      at: comment.updated_at,
      commit: undefined as string | undefined,
    })),
  ]
    .filter((post) => post.login && sameLogin(post.login, reviewer) && CONFIDENCE.test(post.body))
    .sort((a, b) => a.at.localeCompare(b.at));
  const last = posts.at(-1);
  const match = last && CONFIDENCE.exec(last.body);
  if (!last || !match) return undefined;
  return { score: Number(match[1]), total: Number(match[2]), ...(last.commit && { commit: last.commit }) };
}

/**
 * The bots that a comment asks for a review after their last review, such as "@sakuga-review review
 * balanced". A line of the comment must start with the mention and contain the word "review". A thank
 * you to the bot is not a request. The author of the comment must not be that bot: a
 * bot can quote its own command. An agent can post as a bot, so a request of another bot counts. A
 * bot is a bot login of a review or a comment of the pull request.
 */
export function unansweredRequests(facts: Pick<PolicyFacts, 'reviews' | 'comments'>): string[] {
  const logins = [
    ...facts.reviews.map((review) => review.user?.login),
    ...facts.comments.map((post) => post.user?.login),
  ];
  const bots = [...new Set(logins.filter((login): login is string => Boolean(login) && isBotLogin(login!)))];
  return bots.filter((bot) => {
    const lastReview = facts.reviews
      .filter((review) => review.user?.login === bot)
      .reduce((last, review) => (review.submitted_at > last ? review.submitted_at : last), '');
    const name = bot.replace(/\[bot\]$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mention = new RegExp(`^\\s*@${name}(?![\\w-])[^\\n]*\\breview\\b`, 'im');
    return facts.comments.some(
      (post) => post.user && post.user.login !== bot && post.created_at > lastReview && mention.test(post.body),
    );
  });
}

/** Returns the rules of the policy that the pull request misses, in the order of the settings file. */
export function policyMisses(policy: MergePolicy | undefined, facts: PolicyFacts): PolicyMiss[] {
  if (!policy) return [];
  const misses: PolicyMiss[] = [];
  const { minScore, requireProof, resolvedBotThreads, ownerOnly, answeredReviewRequests } = policy;
  if (minScore) {
    const last = lastScore(minScore.reviewer, facts);
    if (!last) misses.push({ rule: 'minScore', note: `no score from ${minScore.reviewer}` });
    else if (minScore.onHead && last.commit !== facts.head)
      misses.push({ rule: 'minScore', note: `no score from ${minScore.reviewer} on head` });
    else if (last.score < minScore.score)
      misses.push({
        rule: 'minScore',
        note: `score ${last.score}/${last.total}${minScore.onHead ? ' on head' : ''}, ${minScore.score} needed`,
      });
  }
  if (requireProof) {
    const proof = new RegExp(requireProof, 'i');
    if (![facts.body, ...facts.comments.map((comment) => comment.body)].some((text) => proof.test(text)))
      misses.push({ rule: 'requireProof', note: 'no proof' });
  }
  if (resolvedBotThreads) {
    const open = facts.openThreads.filter(isBotLogin).length;
    if (open > 0) misses.push({ rule: 'resolvedBotThreads', note: `${open} open bot thread${open === 1 ? '' : 's'}` });
  }
  if (ownerOnly && ownerOnly.owner !== '@me') {
    const patterns = ownerOnly.paths.map(globToRegExp);
    const files = facts.files;
    // A file after the files that the query read can be an owned file. The rule then blocks the merge.
    const partial = files !== undefined && facts.changedFiles !== undefined && files.length < facts.changedFiles;
    const owned = files?.some((file) => patterns.some((pattern) => pattern.test(file)));
    if ((owned || partial) && !(facts.viewer && sameLogin(facts.viewer, ownerOnly.owner)))
      misses.push({
        rule: 'ownerOnly',
        note: owned ? `${ownerOnly.owner} merges` : `${ownerOnly.owner} merges: more than ${files!.length} files`,
      });
  }
  if (answeredReviewRequests)
    for (const bot of unansweredRequests(facts))
      misses.push({ rule: 'answeredReviewRequests', note: `review asked of ${displayName(bot)}, no answer yet` });
  return misses;
}
