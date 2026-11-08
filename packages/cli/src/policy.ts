import { displayName, isBotLogin } from './reviewers.js';
import type { Comment, Review } from './decide.js';
import { reviewBotsOf, threadAnswered, type Finding, type FindingPlace } from './findings.js';

/** The rules that a team adds to "ready to merge", from the `mergePolicy` of the settings file. */
export interface MergePolicy {
  /**
   * The last confidence score of `reviewer` must be at least `score`, from a review of the head commit if `onHead`.
   * `reviewer` can be a list of logins that count as one reviewer, for a review App that changed its name.
   * `commands` are the mentions that ask that reviewer for a review, such as "@kento-ai".
   */
  minScore?: {
    reviewer: string | string[];
    score: number;
    onHead: boolean;
    deepest?: ReviewLevels;
    commands?: string[];
  };
  /** A regular expression that the description or a comment must match: a link to a recording, or a reason. */
  requireProof?: string;
  /**
   * Every review thread that a bot starts must be resolved. A thread whose last comment is a bot
   * comment that contains `goneMarker` counts as resolved: the bot says that its finding is gone.
   */
  resolvedBotThreads?: true | { goneMarker: string };
  /** Only `owner` merges a pull request that changes a file under one of `paths`. `@me` is the user of boo. */
  ownerOnly?: { paths: string[]; owner: string };
  /** A review that a comment asks of a bot after its last review must come before the merge. */
  answeredReviewRequests?: boolean;
  /** Each finding of a review bot with one of these levels, such as "P1", must have an answer: see findings.ts. */
  answerFindings?: string[];
}

/**
 * The levels of the reviews of a bot, from the lightest to the deepest. The first group of `pattern`
 * gives the level of a review. A review with no level, or with an unknown level, is the lightest.
 */
export interface ReviewLevels {
  pattern: string;
  levels: string[];
}

export type PolicyRule =
  | 'minScore'
  | 'requireProof'
  | 'resolvedBotThreads'
  | 'ownerOnly'
  | 'answeredReviewRequests'
  | 'answerFindings';

/** A rule that the pull request misses, with the note that the details and the merge refusal show. */
export interface PolicyMiss {
  rule: PolicyRule;
  note: string;
}

/** A review thread that is not resolved. */
export interface OpenThread {
  /** The author of the first comment. */
  author: string;
  /** The body of the last comment of the thread, if a bot wrote it. A reply of a person after the bot clears it. */
  lastBotComment?: string;
  /** The body of the first comment: the finding of a bot. */
  body?: string;
  /** The author of the last comment. */
  lastAuthor?: string;
}

/** The facts of a pull request that the rules read. */
export interface PolicyFacts {
  head: string;
  body: string;
  reviews: readonly Review[];
  comments: readonly Comment[];
  openThreads: readonly OpenThread[];
  /** The changed files. Undefined if GitHub gave no list. */
  files?: readonly string[] | undefined;
  /** The count of changed files. The list can hold fewer: the query reads the first 100. */
  changedFiles?: number | undefined;
  /** The login of the user of boo, if GitHub gave it. */
  viewer?: string | undefined;
  /** The author of the pull request: a reply of the author answers a bot thread. */
  author?: string;
  /** The findings of the review bots. Only the `answerFindings` rule reads them. */
  findings?: readonly Finding[];
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
  threads: Boolean(policy?.resolvedBotThreads || policy?.answerFindings),
  files: Boolean(policy?.ownerOnly),
});

/** Reads a text or a list of texts. Drops the empty texts and the duplicates. */
const texts = (value: unknown): string[] => [
  ...new Set(
    (Array.isArray(value) ? value : [value])
      .filter((text): text is string => typeof text === 'string')
      .map((text) => text.trim())
      .filter(Boolean),
  ),
];

/** The logins of the score reviewer. The first login names the reviewer in the notes. */
export const reviewerLogins = (minScore: NonNullable<MergePolicy['minScore']>): string[] =>
  Array.isArray(minScore.reviewer) ? minScore.reviewer : [minScore.reviewer];

function parseLevels(value: unknown): ReviewLevels | undefined {
  if (!isRecord(value) || typeof value.pattern !== 'string' || !compiles(value.pattern)) return undefined;
  if (!/\((?!\?)/.test(value.pattern)) return undefined;
  const levels = Array.isArray(value.levels)
    ? value.levels.filter((level): level is string => typeof level === 'string' && Boolean(level.trim()))
    : [];
  return levels.length > 0 ? { pattern: value.pattern, levels: levels.map((level) => level.trim()) } : undefined;
}

/** Reads the merge policy from any JSON value. A rule with a missing or invalid field is dropped. */
export function parseMergePolicy(value: unknown): MergePolicy | undefined {
  if (!isRecord(value)) return undefined;
  const policy: MergePolicy = {};
  const { minScore, requireProof, resolvedBotThreads, ownerOnly, answeredReviewRequests } = value;
  const reviewers = isRecord(minScore) ? texts(minScore.reviewer) : [];
  if (isRecord(minScore) && reviewers.length > 0 && typeof minScore.score === 'number' && minScore.score > 0) {
    const deepest = parseLevels(minScore.deepest);
    const commands = texts(minScore.commands);
    policy.minScore = {
      // One login stays a string, so that the settings file keeps the shape that older versions read.
      reviewer: reviewers.length === 1 ? reviewers[0]! : reviewers,
      score: minScore.score,
      onHead: minScore.onHead === true,
      ...(deepest && { deepest }),
      ...(commands.length > 0 && { commands }),
    };
  }
  if (typeof requireProof === 'string' && requireProof.trim() && compiles(requireProof))
    policy.requireProof = requireProof;
  if (resolvedBotThreads === true) policy.resolvedBotThreads = true;
  else if (
    isRecord(resolvedBotThreads) &&
    typeof resolvedBotThreads.goneMarker === 'string' &&
    resolvedBotThreads.goneMarker.trim()
  )
    policy.resolvedBotThreads = { goneMarker: resolvedBotThreads.goneMarker.trim() };
  if (isRecord(ownerOnly) && Array.isArray(ownerOnly.paths) && typeof ownerOnly.owner === 'string') {
    const paths = ownerOnly.paths.filter((path): path is string => typeof path === 'string' && Boolean(path.trim()));
    if (paths.length > 0 && ownerOnly.owner.trim()) policy.ownerOnly = { paths, owner: ownerOnly.owner.trim() };
  }
  if (answeredReviewRequests === true) policy.answeredReviewRequests = true;
  const levels = Array.isArray(value.answerFindings)
    ? [
        ...new Set(
          value.answerFindings
            .filter((level): level is string => typeof level === 'string' && /^p\d$/i.test(level.trim()))
            .map((level) => level.trim().toUpperCase()),
        ),
      ]
    : [];
  if (levels.length > 0) policy.answerFindings = levels;
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

interface ScoredPost {
  body: string;
  at: string;
  /** The commit of a review. A comment has no commit. */
  commit?: string;
  score: number;
  total: number;
}

/** The posts of the reviewer that give a score, from the oldest to the newest. */
function scoredPosts(logins: readonly string[], facts: PolicyFacts): ScoredPost[] {
  return [
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
    .flatMap(({ login, body, at, commit }) => {
      const match = login && logins.some((reviewer) => sameLogin(login, reviewer)) ? CONFIDENCE.exec(body) : null;
      if (!match) return [];
      return [{ body, at, ...(commit && { commit }), score: Number(match[1]), total: Number(match[2]) }];
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The score that the rule reads. With no levels, the last score. With levels, the deepest level of
 * all the scored posts counts. The score is the lowest of that level on the head commit if `onHead`,
 * else on the commit of the last post of that level.
 */
function scoreOf(
  minScore: NonNullable<MergePolicy['minScore']>,
  facts: PolicyFacts,
): { post?: ScoredPost; level?: string } {
  const posts = scoredPosts(reviewerLogins(minScore), facts);
  const { deepest } = minScore;
  if (!deepest) return { post: posts.at(-1) };
  const pattern = new RegExp(deepest.pattern, 'i');
  const levels = deepest.levels.map((level) => level.toLowerCase());
  const depth = (post: ScoredPost) => levels.indexOf(pattern.exec(post.body)?.[1]?.toLowerCase() ?? '');
  const bottom = Math.max(...posts.map(depth));
  const deep = posts.filter((post) => depth(post) === bottom);
  const level = bottom >= 0 ? deepest.levels[bottom] : undefined;
  const commit = minScore.onHead ? facts.head : deep.at(-1)?.commit;
  const counted = commit ? deep.filter((post) => post.commit === commit) : deep.slice(-1);
  const post = counted.reduce<ScoredPost | undefined>(
    (low, next) => (!low || next.score < low.score ? next : low),
    undefined,
  );
  return { ...(post ? { post } : { post: deep.at(-1) }), ...(level && { level }) };
}

/** One reviewer with several logins, and the mentions that ask it for a review. */
export interface ReviewerGroup {
  logins: readonly string[];
  /** The mentions that start a request, in addition to "@" + each login, such as "@kento-ai". */
  commands: readonly string[];
  /** The words that ask for a review after a mention, in addition to "review", such as "heavy". */
  levels: readonly string[];
}

/** The reviewer group of the score rule, if it has one. */
export function reviewerGroup(policy: MergePolicy | undefined): ReviewerGroup | undefined {
  const minScore = policy?.minScore;
  if (!minScore) return undefined;
  return {
    logins: reviewerLogins(minScore),
    commands: minScore.commands ?? [],
    levels: minScore.deepest?.levels ?? [],
  };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lastReviewOf = (reviews: readonly Review[], counts: (login: string) => boolean) =>
  reviews
    .filter((review) => review.user && counts(review.user.login))
    .reduce((last, review) => (review.submitted_at > last ? review.submitted_at : last), '');

/** A comment that asks a bot for a review. `bot` names the bot, and `member` tells if a login is that bot. */
export interface ReviewRequest {
  comment: Comment;
  bot: string;
  member: (login: string) => boolean;
}

/**
 * The comments that ask a bot for a review, from the oldest to the newest, such as "@sakuga-review
 * review balanced". A line of the comment must start with the mention and contain the word "review".
 * A thank you to the bot is not a request. The author of the comment must not be that bot: a bot can
 * quote its own command. An agent can post as a bot, so a request of another bot counts. A bot is a
 * bot login of a review or a comment of the pull request.
 * The logins of `group` count as one bot, named by its first login: a command of the group asks all
 * of them. For the group, a level right after the mention also asks: "@kento-review heavy".
 * "@kento-review reject …" is not a request.
 */
export function reviewRequests(
  facts: Pick<PolicyFacts, 'reviews' | 'comments'>,
  group?: ReviewerGroup,
): ReviewRequest[] {
  const inGroup = (login: string) => Boolean(group?.logins.some((other) => sameLogin(login, other)));
  const logins = [
    ...facts.reviews.map((review) => review.user?.login),
    ...facts.comments.map((post) => post.user?.login),
  ];
  const bots = [
    ...new Set(logins.filter((login): login is string => Boolean(login) && isBotLogin(login!) && !inGroup(login!))),
  ];
  const askers: { bot: string; member: (login: string) => boolean; asks: (body: string) => boolean }[] = bots.map(
    (bot) => {
      const mention = new RegExp(`^\\s*@${escape(bot.replace(/\[bot\]$/, ''))}(?![\\w-])[^\\n]*\\breview\\b`, 'im');
      return { bot, member: (login: string) => login === bot, asks: (body: string) => mention.test(body) };
    },
  );
  if (group) {
    const mentions = [...group.commands, ...group.logins.map((login) => `@${login.replace(/\[bot\]$/, '')}`)];
    const line = new RegExp(`^\\s*(?:${mentions.map(escape).join('|')})(?![\\w-])([^\\n]*)`, 'gim');
    // A level counts only as the first word after the mention: "@kento-review the lite mode works" is no request.
    const level = new RegExp(`^\\s*(?:${group.levels.map(escape).join('|') || '(?!)'})\\b`, 'i');
    const asks = (rest: string) => /\breview\b/i.test(rest) || level.test(rest);
    askers.unshift({
      bot: group.logins[0]!,
      member: inGroup,
      asks: (body: string) => [...body.matchAll(line)].some((match) => asks(match[1]!)),
    });
  }
  return facts.comments
    .flatMap((comment) =>
      askers
        .filter(({ member, asks }) => comment.user && !member(comment.user.login) && asks(comment.body))
        .map(({ bot, member }) => ({ comment, bot, member })),
    )
    .sort((a, b) => a.comment.created_at.localeCompare(b.comment.created_at));
}

/** The bots that a comment asks for a review after their last review (see `reviewRequests`), the group first. */
export function unansweredRequests(facts: Pick<PolicyFacts, 'reviews' | 'comments'>, group?: ReviewerGroup): string[] {
  const asked = reviewRequests(facts, group).filter(
    ({ comment, member }) => comment.created_at > lastReviewOf(facts.reviews, member),
  );
  const bots = [...new Set(asked.map(({ bot }) => bot))];
  return group && bots.includes(group.logins[0]!)
    ? [group.logins[0]!, ...bots.filter((bot) => bot !== group.logins[0])]
    : bots;
}

/**
 * Counts the unresolved threads that a bot started: `open` has no answer, `answered` ends with a reply
 * of the author, a person or an agent (see `threadAnswered`). A thread whose last bot comment has the
 * gone marker counts as resolved.
 */
export function botThreads(
  rule: NonNullable<MergePolicy['resolvedBotThreads']> | undefined,
  facts: Pick<PolicyFacts, 'openThreads' | 'reviews' | 'author'>,
): { open: number; answered: number } {
  const marker = rule && rule !== true ? rule.goneMarker : undefined;
  const reviewBots = reviewBotsOf(facts.reviews, facts.author ?? '');
  const threads = facts.openThreads.filter(
    (thread) => isBotLogin(thread.author) && !(marker && thread.lastBotComment?.includes(marker)),
  );
  const answered = threads.filter((thread) => threadAnswered(thread, reviewBots)).length;
  return { open: threads.length - answered, answered };
}

/** Returns the rules of the policy that the pull request misses, in the order of the settings file. */
export function policyMisses(policy: MergePolicy | undefined, facts: PolicyFacts): PolicyMiss[] {
  if (!policy) return [];
  const misses: PolicyMiss[] = [];
  const { minScore, requireProof, resolvedBotThreads, ownerOnly, answeredReviewRequests, answerFindings } = policy;
  if (minScore) {
    const { post, level } = scoreOf(minScore, facts);
    const from = `${level ? `${level} ` : ''}score from ${reviewerLogins(minScore)[0]}`;
    if (!post) misses.push({ rule: 'minScore', note: `no ${from}` });
    else if (minScore.onHead && post.commit !== facts.head)
      misses.push({ rule: 'minScore', note: `no ${from} on head` });
    else if (post.score < minScore.score)
      misses.push({
        rule: 'minScore',
        note: `${level ? `${level} ` : ''}score ${post.score}/${post.total}${minScore.onHead ? ' on head' : ''}, ${minScore.score} needed`,
      });
  }
  if (requireProof) {
    const proof = new RegExp(requireProof, 'i');
    if (![facts.body, ...facts.comments.map((comment) => comment.body)].some((text) => proof.test(text)))
      misses.push({ rule: 'requireProof', note: 'no proof' });
  }
  if (resolvedBotThreads) {
    const { open, answered } = botThreads(resolvedBotThreads, facts);
    const plural = (count: number) => (count === 1 ? '' : 's');
    if (open > 0) misses.push({ rule: 'resolvedBotThreads', note: `${open} open bot thread${plural(open)}` });
    // An answered thread waits only for a person who reads the answer and resolves the thread.
    if (answered > 0)
      misses.push({
        rule: 'resolvedBotThreads',
        note: `${answered} answered bot thread${plural(answered)} to resolve`,
      });
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
    for (const bot of unansweredRequests(facts, reviewerGroup(policy)))
      misses.push({ rule: 'answeredReviewRequests', note: `review asked of ${displayName(bot)}, no answer yet` });
  if (answerFindings) {
    const places: FindingPlace[] = ['thread', 'review', 'description'];
    for (const level of answerFindings)
      for (const place of places) {
        const open = (facts.findings ?? []).filter(
          (finding) => finding.level === level && finding.place === place && !finding.answered,
        ).length;
        if (open > 0) misses.push({ rule: 'answerFindings', note: `${open} ${level} not answered (${place})` });
      }
  }
  return misses;
}
