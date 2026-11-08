import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment, Review } from './decide.js';
import { findingsIn, findingsOf, summarizeFindings } from './findings.js';
import { parseMergePolicy, policyMisses } from './policy.js';

const badge = (level: string) =>
  `<img alt="${level}" src="https://img.shields.io/badge/${level}-6c757d?style=flat-square" align="top">`;
const BLOCK = [
  'My description.',
  '<!-- sakuga-review:start -->',
  '<h3>Constats</h3>',
  `1. ${badge('P2')}&nbsp;**Page de recherche sans filtre d'unicité fiable** \`#1631f7\` \`apps/worker/src/gitlab-store.ts:163\``,
  `2. ${badge('P2')} <img alt="sécurité" src="x">&nbsp;**Adresse littérale vérifiée seulement avec isIP** \`#fa2a84\` \`a.ts:42\``,
  `3. ${badge('P1')}&nbsp;**Cache des échecs pour toujours** \`b.ts:9\``,
  '<!-- sakuga-review:end -->',
].join('\n');
const KENTO = 'kento-review[bot]';
const comment = (login: string, body: string, at = '2026-11-08T12:00:00Z'): Comment => ({
  user: { login },
  body,
  created_at: at,
  updated_at: at,
});
const review = (login: string, body: string, at: string): Review => ({
  user: { login },
  commit_id: 'head',
  submitted_at: at,
  state: 'COMMENTED',
  body,
});

test('a finding is a line with a level badge, its title in bold, and its short ID', () => {
  assert.deepEqual(findingsIn(BLOCK), [
    { level: 'P2', title: "Page de recherche sans filtre d'unicité fiable", id: '#1631f7' },
    { level: 'P2', title: 'Adresse littérale vérifiée seulement avec isIP', id: '#fa2a84' },
    { level: 'P1', title: 'Cache des échecs pour toujours' },
  ]);
});

test('the findings of the threads, the last review of each bot and the description, with their answers', () => {
  const findings = findingsOf({
    author: 'sakuga-agent[bot]',
    body: BLOCK,
    reviews: [
      review('coderabbitai[bot]', 'Looks fine.', '2026-11-08T08:00:00Z'),
      review(KENTO, `${badge('P1')} **Old finding of an old round**`, '2026-11-08T09:00:00Z'),
      review(KENTO, `Score 3/5\n\n- ${badge('P3')} **Un nom peu clair**`, '2026-11-08T10:00:00Z'),
      review('sakuga-agent[bot]', `${badge('P1')} **The author quotes a badge**`, '2026-11-08T10:30:00Z'),
    ],
    comments: [
      comment(
        'sakuga-agent[bot]',
        '**Page de recherche sans filtre d’unicité fiable**: fixed in abc.'.replace('’', "'"),
      ),
      comment('sakuga-agent[bot]', 'About `#fa2a84`: refuted, isIP is not the only check.'),
      comment(KENTO, '**Cache des échecs pour toujours** was found again.'),
      comment('sakuga-agent[bot]', 'Un nom peu clair: renamed.', '2026-11-08T09:30:00Z'),
    ],
    openThreads: [
      { author: KENTO, body: `${badge('P1')} **Redirection non refusée**\n\nText.`, lastAuthor: 'sakuga-agent[bot]' },
      { author: KENTO, body: `${badge('P2')} **Second thread**`, lastAuthor: KENTO },
      { author: 'alice', body: `${badge('P1')} **A person**` },
      { author: KENTO, body: `${badge('P2')} **Another bot replied**`, lastAuthor: 'coderabbitai[bot]' },
      { author: KENTO, body: 'No badge here.' },
    ],
  });
  assert.deepEqual(
    findings.map(({ level, place, answered }) => `${place} ${level} ${answered ? 'answered' : 'open'}`),
    [
      'thread P1 answered',
      'thread P2 open',
      'thread P2 open',
      'review P3 open',
      'description P2 answered',
      'description P2 answered',
      'description P1 open',
    ],
  );
  const summary = summarizeFindings(findings);
  assert.deepEqual(summary.levels, {
    P1: { count: 2, answered: 1 },
    P2: { count: 4, answered: 2 },
    P3: { count: 1, answered: 0 },
  });
  assert.deepEqual(summary.places, {
    thread: { count: 3, answered: 1 },
    review: { count: 1, answered: 0 },
    description: { count: 3, answered: 2 },
  });
  assert.equal(summary.count, 7);
  assert.equal(summary.answered, 3);
  assert.deepEqual(summary.unanswered.at(-1), {
    level: 'P1',
    place: 'description',
    title: 'Cache des échecs pour toujours',
    id: null,
  });
});

test('the answerFindings rule names the level and the place of the findings with no answer', () => {
  const policy = parseMergePolicy({ answerFindings: ['p1', 'P2', 'high', 2] })!;
  assert.deepEqual(policy, { answerFindings: ['P1', 'P2'] });
  const findings = findingsOf({ author: 'me', body: BLOCK, reviews: [], comments: [] });
  const facts = { head: 'head', body: BLOCK, reviews: [], comments: [], openThreads: [], findings };
  assert.deepEqual(policyMisses(policy, facts), [
    { rule: 'answerFindings', note: '1 P1 not answered (description)' },
    { rule: 'answerFindings', note: '2 P2 not answered (description)' },
  ]);
  assert.deepEqual(policyMisses({ answerFindings: ['P3'] }, facts), []);
});

test('a description with no block counts the whole text, and no badge gives no finding', () => {
  assert.equal(findingsOf({ author: 'me', body: `- ${badge('P2')} **A**`, reviews: [], comments: [] }).length, 1);
  assert.deepEqual(summarizeFindings([]), {
    count: 0,
    answered: 0,
    levels: {},
    places: {
      thread: { count: 0, answered: 0 },
      review: { count: 0, answered: 0 },
      description: { count: 0, answered: 0 },
    },
    unanswered: [],
  });
});

test('a quote of the start marker in the text of the description does not move the block', () => {
  const body = `Parses the block (\`<!-- sakuga-review:start -->\` … \`end\`). ${badge('P3')} **Not a finding**\n\n${BLOCK}`;
  assert.deepEqual(
    findingsOf({ author: 'me', body, reviews: [], comments: [] }).map(({ title }) => title),
    findingsIn(BLOCK).map(({ title }) => title),
  );
});
