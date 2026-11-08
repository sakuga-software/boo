import type { Comment, Review } from './decide.js';
import type { OpenThread } from './policy.js';
import { isBotLogin } from './reviewers.js';

/** Where a review bot wrote a finding: an open review thread, the body of its last review, or a block of the description. */
export type FindingPlace = 'thread' | 'review' | 'description';

/** A finding of a review bot, with a level badge such as P1 or P2. */
export interface Finding {
  level: string;
  place: FindingPlace;
  title: string;
  /** The short ID that the bot shows, such as "#1631f7", if it shows one. */
  id?: string;
  bot: string;
  /** The author of the pull request, or another account than the bot, answered it since it was posted. */
  answered: boolean;
}

export interface FindingCount {
  count: number;
  answered: number;
}

/** The findings of a pull request, counted by level and by place. */
export interface FindingsSummary {
  count: number;
  answered: number;
  levels: Record<string, FindingCount>;
  places: Record<FindingPlace, FindingCount>;
  /** The findings with no answer, in the order of their place: threads, reviews, description. */
  unanswered: { level: string; place: FindingPlace; title: string; id: string | null }[];
  /** False if the read did not read the threads: `places.thread` then counts nothing that is known. */
  threadsRead: boolean;
}

export interface FindingFacts {
  author: string;
  body: string;
  reviews: readonly Review[];
  comments: readonly Comment[];
  /** The logins of the agents of the settings (`authors`): an agent can post as a bot, and answer. */
  agents?: readonly string[] | undefined;
  /** Undefined if the read did not read the threads: the threads then count no finding. */
  openThreads?: readonly OpenThread[] | undefined;
}

// A badge of a level, as Kentō, pr-audit.sh and the shields of other bots write it: <img alt="P2" …>.
const BADGE = /<img\b[^>]*\balt="(P\d)"/i;
const TITLE = /\*\*(.+?)\*\*/;
const SHORT_ID = /`(#[0-9a-f]{6,12})`/i;
// The block of Sakuga Review in the description: its markers stand on their own lines. A text can
// quote a marker inline, so the last start marker counts. With no block, the whole description counts.
const START = /^<!-- sakuga-review:start -->\s*$/gm;
const END = /^<!-- sakuga-review:end -->\s*$/m;
const blockOf = (body: string) => {
  const start = [...body.matchAll(START)].at(-1);
  if (!start) return body;
  const rest = body.slice(start.index + start[0].length);
  const end = END.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
};

const sameLogin = (a: string, b: string) =>
  a.replace(/\[bot\]$/, '').toLowerCase() === b.replace(/\[bot\]$/, '').toLowerCase();
// A quote of a title in an answer can drop the bold, the code marks and the case.
const plain = (text: string) =>
  text
    .replace(/[*`_]/g, '')
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** The findings of one text: one for each line with a level badge, its title in bold, and its short ID. */
export function findingsIn(text: string): { level: string; title: string; id?: string }[] {
  return text.split('\n').flatMap((line) => {
    const badge = BADGE.exec(line);
    if (!badge) return [];
    const after = line.slice(badge.index);
    const title = TITLE.exec(after)?.[1]?.trim() ?? '';
    const id = SHORT_ID.exec(after)?.[1];
    return [{ level: badge[1]!.toUpperCase(), title, ...(id && { id }) }];
  });
}

/**
 * Finds the findings of the review bots, and tells if each one has an answer:
 * - a finding of an open thread has an answer if the last comment of the thread answers (see `answers`);
 * - a finding of the last review of a bot, or of the description, has an answer if a comment that is
 *   answers quotes its title or gives its short ID. A finding of a review counts only the
 *   comments after the review. The description has no time: any comment counts.
 */
export function findingsOf(facts: FindingFacts): Finding[] {
  const findings: Finding[] = [];
  // An answer comes from the author, a person, or an agent of the settings: not from a bot that reviews or runs CI.
  const answers = (login: string) =>
    !isBotLogin(login) ||
    sameLogin(login, facts.author) ||
    (facts.agents ?? []).some((agent) => sameLogin(agent, login));
  for (const thread of facts.openThreads ?? []) {
    if (!isBotLogin(thread.author) || sameLogin(thread.author, facts.author) || !thread.body) continue;
    // A reply of another review bot is no answer: only the author, a person or an agent answers.
    const last = thread.lastAuthor;
    const answered = Boolean(last && !sameLogin(last, thread.author) && answers(last));
    for (const finding of findingsIn(thread.body).slice(0, 1))
      findings.push({ ...finding, place: 'thread', bot: thread.author, answered });
  }
  const quoted = (finding: { title: string; id?: string }, since = '') =>
    facts.comments.some((comment) => {
      if (!comment.user || !answers(comment.user.login)) return false;
      if (comment.created_at <= since) return false;
      const text = plain(comment.body);
      return (
        (finding.title !== '' && text.includes(plain(finding.title))) ||
        (finding.id !== undefined && text.includes(finding.id.toLowerCase()))
      );
    });
  const lastReviews = new Map<string, Review>();
  for (const review of facts.reviews) {
    const login = review.user?.login;
    if (!login || !isBotLogin(login) || sameLogin(login, facts.author) || review.threadReply) continue;
    const known = lastReviews.get(login);
    if (!known || review.submitted_at > known.submitted_at) lastReviews.set(login, review);
  }
  for (const [bot, review] of lastReviews)
    for (const finding of findingsIn(review.body ?? ''))
      findings.push({ ...finding, place: 'review', bot, answered: quoted(finding, review.submitted_at) });
  const block = blockOf(facts.body);
  // The block of the description has no author: an answer of any account but a review bot counts.
  for (const finding of findingsIn(block))
    findings.push({ ...finding, place: 'description', bot: '', answered: quoted(finding) });
  return findings;
}

const PLACES: readonly FindingPlace[] = ['thread', 'review', 'description'];

export function summarizeFindings(findings: readonly Finding[], threadsRead = false): FindingsSummary {
  const count = (list: readonly Finding[]): FindingCount => ({
    count: list.length,
    answered: list.filter((finding) => finding.answered).length,
  });
  const levels = [...new Set(findings.map((finding) => finding.level))].sort();
  return {
    ...count(findings),
    levels: Object.fromEntries(levels.map((level) => [level, count(findings.filter((f) => f.level === level))])),
    places: Object.fromEntries(
      PLACES.map((place) => [place, count(findings.filter((f) => f.place === place))]),
    ) as Record<FindingPlace, FindingCount>,
    unanswered: findings
      .filter((finding) => !finding.answered)
      .map(({ level, place, title, id }) => ({ level, place, title, id: id ?? null })),
    threadsRead,
  };
}

/** The logins of the agents of a list of authors: "app/my-agent" is "my-agent[bot]". "@me" names no login. */
export const agentLogins = (authors: readonly string[]): string[] =>
  authors.flatMap((author) => {
    if (author === '@me') return [];
    return [author.startsWith('app/') ? `${author.slice(4)}[bot]` : author];
  });
