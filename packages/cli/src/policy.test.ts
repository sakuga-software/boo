import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment, Review } from './decide.js';
import {
  botThreads,
  globToRegExp,
  parseMergePolicy,
  policyMisses,
  unansweredRequests,
  type PolicyFacts,
} from './policy.js';
import { parseSettings } from './settings.js';

const at = (minutes: number) => new Date(Date.parse('2026-10-24T12:00:00Z') - minutes * 60_000).toISOString();
const review = (login: string, commit: string, body: string, minutesAgo: number): Review => ({
  user: { login },
  commit_id: commit,
  submitted_at: at(minutesAgo),
  state: 'COMMENTED',
  body,
});
const comment = (login: string, body: string, minutesAgo: number): Comment => ({
  user: { login },
  body,
  created_at: at(minutesAgo),
  updated_at: at(minutesAgo),
});
const facts = (patch: Partial<PolicyFacts> = {}): PolicyFacts => ({
  head: 'head',
  body: '',
  reviews: [],
  comments: [],
  openThreads: [],
  ...patch,
});
const SAKUGA = 'sakuga-review[bot]';
const minScore = { reviewer: 'sakuga-review', score: 4, onHead: true };

test('no policy, no miss', () => {
  assert.deepEqual(policyMisses(undefined, facts()), []);
});

test('the score rule reads the last score of the reviewer, and its commit when onHead', () => {
  const policy = { minScore };
  assert.deepEqual(policyMisses(policy, facts()), [{ rule: 'minScore', note: 'no score from sakuga-review' }]);
  const old = review(SAKUGA, 'old', '**Score de confiance : 5/5**', 30);
  assert.deepEqual(policyMisses(policy, facts({ reviews: [old] })), [
    { rule: 'minScore', note: 'no score from sakuga-review on head' },
  ]);
  const low = review(SAKUGA, 'head', '**Score de confiance : 3/5**', 5);
  assert.deepEqual(policyMisses(policy, facts({ reviews: [old, low] })), [
    { rule: 'minScore', note: 'score 3/5 on head, 4 needed' },
  ]);
  const high = review(SAKUGA, 'head', '**Score de confiance : 4/5**', 1);
  assert.deepEqual(policyMisses(policy, facts({ reviews: [old, low, high] })), []);
});

test('a score in a comment has no commit: it passes only a rule without onHead', () => {
  const scored = facts({ comments: [comment('greptile-apps[bot]', 'Confidence Score: 5/5', 1)] });
  assert.deepEqual(policyMisses({ minScore: { reviewer: 'greptile-apps', score: 4, onHead: false } }, scored), []);
  assert.equal(policyMisses({ minScore: { reviewer: 'greptile-apps', score: 4, onHead: true } }, scored).length, 1);
});

test('with levels, the deepest level counts, with its lowest score on head', () => {
  const deepest = { pattern: 'Niveau `(\\w+)`', levels: ['lite', 'balanced', 'heavy'] };
  const rule = { minScore: { ...minScore, deepest } };
  const scored = (commit: string, score: number, level: string, minutesAgo: number) =>
    review(SAKUGA, commit, `Score de confiance : ${score}/5\nNiveau \`${level}\``, minutesAgo);
  const older = [scored('old', 3, 'lite', 40), scored('old', 3, 'heavy', 30)];
  const lite = scored('head', 4, 'lite', 10);
  assert.deepEqual(policyMisses({ minScore }, facts({ reviews: [...older, lite] })), []);
  assert.deepEqual(policyMisses(rule, facts({ reviews: [...older, lite] })), [
    { rule: 'minScore', note: 'no heavy score from sakuga-review on head' },
  ]);
  const heavy = [scored('head', 5, 'heavy', 5), scored('head', 3, 'heavy', 2)];
  assert.deepEqual(policyMisses(rule, facts({ reviews: [...older, lite, ...heavy] })), [
    { rule: 'minScore', note: 'heavy score 3/5 on head, 4 needed' },
  ]);
  assert.deepEqual(policyMisses(rule, facts({ reviews: [...older, lite, heavy[0]!] })), []);
  const offHead = { minScore: { ...minScore, onHead: false, deepest } };
  assert.deepEqual(policyMisses(offHead, facts({ reviews: [...older, lite] })), [
    { rule: 'minScore', note: 'heavy score 3/5, 4 needed' },
  ]);
  assert.deepEqual(policyMisses(rule, facts({ reviews: [review(SAKUGA, 'head', 'Score de confiance : 4/5', 1)] })), []);
});

test('a renamed review App: every login of the reviewer list gives the score', () => {
  const renamed = { minScore: { ...minScore, reviewer: ['kento-review', 'sakuga-review'] } };
  const old = review(SAKUGA, 'head', 'Score de confiance : 5/5', 10);
  assert.deepEqual(policyMisses(renamed, facts({ reviews: [old] })), []);
  const low = review('kento-review[bot]', 'head', 'Score de confiance : 3/5', 1);
  assert.deepEqual(policyMisses(renamed, facts({ reviews: [old, low] })), [
    { rule: 'minScore', note: 'score 3/5 on head, 4 needed' },
  ]);
  assert.deepEqual(policyMisses(renamed, facts()), [{ rule: 'minScore', note: 'no score from kento-review' }]);
});

test('a request to one login of the reviewer list is answered by a review of another login', () => {
  const deepest = { pattern: 'Niveau `(\\w+)`', levels: ['lite', 'balanced', 'heavy'] };
  const group = {
    minScore: { ...minScore, reviewer: ['kento-review', 'sakuga-review'], commands: ['@kento-ai', '@kento'], deepest },
    answeredReviewRequests: true,
  };
  const old = review(SAKUGA, 'head', 'Score de confiance : 4/5', 20);
  const answer = review('kento-review[bot]', 'head', 'Score de confiance : 4/5', 1);
  const unanswered = [{ rule: 'answeredReviewRequests', note: 'review asked of kento-review, no answer yet' }];
  for (const body of ['@sakuga-review review balanced', '@kento-ai review', '@kento heavy', '@kento-review lite']) {
    const ask = comment('mathieu', body, 5);
    assert.deepEqual(policyMisses(group, facts({ reviews: [old], comments: [ask] })), unanswered, body);
    assert.deepEqual(policyMisses(group, facts({ reviews: [old, answer], comments: [ask] })), [], body);
  }
  const reject = comment('mathieu', '@kento-review reject the file is generated', 5);
  const remark = comment('mathieu', '@kento the lite mode is enough here, thanks', 5);
  const ownQuote = comment('kento-review[bot]', '@kento-ai review heavy', 5);
  assert.deepEqual(policyMisses(group, facts({ reviews: [old], comments: [reject, remark, ownQuote] })), []);
  const other = comment('mathieu', '@greptile-apps review', 5);
  const greptile = comment('greptile-apps[bot]', 'Confidence Score: 4/5', 30);
  assert.deepEqual(unansweredRequests({ reviews: [old], comments: [greptile, other] }, undefined), [
    'greptile-apps[bot]',
  ]);
});

test('the reviewer list and the commands are read from the settings', () => {
  assert.deepEqual(
    parseMergePolicy({
      minScore: {
        reviewer: [' kento-review', 'sakuga-review', 3, 'kento-review'],
        score: 4,
        commands: ['@kento-ai', ''],
      },
    })?.minScore,
    { reviewer: ['kento-review', 'sakuga-review'], score: 4, onHead: false, commands: ['@kento-ai'] },
  );
  assert.deepEqual(parseMergePolicy({ minScore: { reviewer: ['kento-review'], score: 4 } })?.minScore, {
    reviewer: 'kento-review',
    score: 4,
    onHead: false,
  });
  assert.equal(parseMergePolicy({ minScore: { reviewer: [], score: 4 } }), undefined);
});

test('the proof can be in the description or in a comment', () => {
  const policy = { requireProof: '\\.(gif|webm|mp4)|No /tfp:' };
  assert.deepEqual(policyMisses(policy, facts({ body: 'A change.' })), [{ rule: 'requireProof', note: 'no proof' }]);
  assert.deepEqual(policyMisses(policy, facts({ body: '![run](https://x/run.gif)' })), []);
  assert.deepEqual(policyMisses(policy, facts({ comments: [comment('mathieu', 'No /tfp: no page', 1)] })), []);
});

test('an open thread of a bot misses the rule, an open thread of a person does not', () => {
  const policy = { resolvedBotThreads: true } as const;
  const threads = (...authors: string[]) => authors.map((author) => ({ author }));
  assert.deepEqual(policyMisses(policy, facts({ openThreads: threads('alice') })), []);
  assert.deepEqual(policyMisses(policy, facts({ openThreads: threads('alice', 'coderabbitai[bot]', 'Copilot') })), [
    { rule: 'resolvedBotThreads', note: '2 open bot threads' },
  ]);
});

test('a bot thread whose last bot comment has the gone marker counts as resolved', () => {
  const gone = 'Ce constat n’apparaît plus au commit abc. <!-- sakuga-review:gone -->';
  const openThreads = [
    { author: SAKUGA, lastBotComment: gone },
    { author: SAKUGA, lastBotComment: 'Still there.' },
    { author: 'alice', lastBotComment: gone },
  ];
  assert.deepEqual(policyMisses({ resolvedBotThreads: { goneMarker: 'sakuga-review:gone' } }, facts({ openThreads })), [
    { rule: 'resolvedBotThreads', note: '1 open bot thread' },
  ]);
  assert.deepEqual(policyMisses({ resolvedBotThreads: true }, facts({ openThreads })), [
    { rule: 'resolvedBotThreads', note: '2 open bot threads' },
  ]);
});

test('a review asked of a bot after its last review holds the merge until the bot answers', () => {
  const policy = { answeredReviewRequests: true };
  const reviewed = review(SAKUGA, 'head', 'Score de confiance : 4/5', 10);
  const ask = comment('mathieu', '@sakuga-review review balanced', 5);
  assert.deepEqual(policyMisses(policy, facts({ reviews: [reviewed], comments: [ask] })), [
    { rule: 'answeredReviewRequests', note: 'review asked of sakuga-review, no answer yet' },
  ]);
  const answer = review(SAKUGA, 'head', 'Score de confiance : 3/5', 1);
  assert.deepEqual(policyMisses(policy, facts({ reviews: [reviewed, answer], comments: [ask] })), []);
  assert.deepEqual(policyMisses({}, facts({ reviews: [reviewed], comments: [ask] })), []);
});

test('only a request at the start of a line, after the last review, and not of the bot itself counts', () => {
  const reviewed = review(SAKUGA, 'head', 'Score de confiance : 4/5', 10);
  const quoted = comment(SAKUGA, 'Commentez `@sakuga-review review heavy`.\n@sakuga-review review heavy', 9);
  const before = comment('mathieu', '@sakuga-review review', 20);
  const inText = comment('mathieu', 'Thanks to @sakuga-review for the review.', 5);
  const otherBot = comment('mathieu', '@sakuga-review-bis review', 5);
  const thanks = comment('mathieu', '@sakuga-review merci, c’est corrigé.\nA review of the code follows.', 5);
  assert.deepEqual(
    unansweredRequests({ reviews: [reviewed], comments: [quoted, before, inText, otherBot, thanks] }),
    [],
  );
  const full = comment('mathieu', '@sakuga-review full review', 4);
  assert.deepEqual(unansweredRequests({ reviews: [reviewed], comments: [full] }), [SAKUGA]);
  assert.deepEqual(
    unansweredRequests({ reviews: [], comments: [quoted, comment('mathieu', 'Please.\n  @Sakuga-Review review', 1)] }),
    [SAKUGA],
  );
  const agent = comment('sakuga-agent[bot]', '@sakuga-review review balanced', 1);
  assert.deepEqual(unansweredRequests({ reviews: [reviewed], comments: [agent] }), [SAKUGA]);
});

test('a change to an owned path needs the owner, and @me is the user of boo', () => {
  const ownerOnly = { paths: ['.github/workflows/**', '**/migrations/**', '**/auth/**'], owner: 'mathieu' };
  const touches = (file: string, viewer?: string) =>
    policyMisses({ ownerOnly }, facts({ files: ['README.md', file], ...(viewer && { viewer }) }));
  assert.deepEqual(touches('.github/workflows/ci.yml', 'alice'), [{ rule: 'ownerOnly', note: 'mathieu merges' }]);
  assert.deepEqual(touches('packages/db/migrations/0001.sql'), [{ rule: 'ownerOnly', note: 'mathieu merges' }]);
  assert.deepEqual(touches('src/auth/token.ts', 'Mathieu'), []);
  assert.deepEqual(touches('src/authority.ts', 'alice'), []);
  assert.deepEqual(policyMisses({ ownerOnly: { ...ownerOnly, owner: '@me' } }, facts({ files: ['auth/x.ts'] })), []);
});

test('a pull request with more files than the query read needs the owner', () => {
  const ownerOnly = { paths: ['**/auth/**'], owner: 'mathieu' };
  const many = facts({ files: Array.from({ length: 100 }, (_, index) => `src/f${index}.ts`), changedFiles: 140 });
  assert.deepEqual(policyMisses({ ownerOnly }, { ...many, viewer: 'alice' }), [
    { rule: 'ownerOnly', note: 'mathieu merges: more than 100 files' },
  ]);
  assert.deepEqual(policyMisses({ ownerOnly }, { ...many, viewer: 'mathieu' }), []);
  assert.deepEqual(policyMisses({ ownerOnly }, { ...many, changedFiles: 100, viewer: 'alice' }), []);
});

test('a glob matches like a shell glob, with ** for any folders', () => {
  assert.ok(globToRegExp('**/migrations/**').test('migrations/0001.sql'));
  assert.ok(globToRegExp('**/migrations/**').test('packages/db/migrations/0001.sql'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/?.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('the settings drop a rule with an invalid field, and keep the others', () => {
  assert.equal(parseMergePolicy(undefined), undefined);
  assert.equal(parseMergePolicy({ requireProof: '(' }), undefined);
  const levels = (deepest: unknown) => parseMergePolicy({ minScore: { reviewer: 'r', score: 4, deepest } })?.minScore;
  assert.deepEqual(levels({ pattern: 'Level (\\w+)', levels: [' lite', 'heavy', 3] }), {
    reviewer: 'r',
    score: 4,
    onHead: false,
    deepest: { pattern: 'Level (\\w+)', levels: ['lite', 'heavy'] },
  });
  for (const invalid of [
    true,
    { pattern: 'Level \\w+', levels: ['a'] },
    { pattern: '(', levels: ['a'] },
    { pattern: '(a)' },
  ])
    assert.equal(levels(invalid)?.deepest, undefined);
  assert.deepEqual(
    parseMergePolicy({
      minScore: { reviewer: 'sakuga-review', score: 4, onHead: true },
      requireProof: '\\.gif',
      resolvedBotThreads: true,
      ownerOnly: { paths: ['**/auth/**', 3], owner: '@me' },
      answeredReviewRequests: true,
    }),
    {
      minScore: { reviewer: 'sakuga-review', score: 4, onHead: true },
      requireProof: '\\.gif',
      resolvedBotThreads: true,
      ownerOnly: { paths: ['**/auth/**'], owner: '@me' },
      answeredReviewRequests: true,
    },
  );
  assert.deepEqual(
    parseSettings({ mergePolicy: { minScore: { reviewer: 'x', score: 'high' } } }).mergePolicy,
    undefined,
  );
  assert.deepEqual(parseMergePolicy({ resolvedBotThreads: { goneMarker: ' sakuga-review:gone ' } }), {
    resolvedBotThreads: { goneMarker: 'sakuga-review:gone' },
  });
  assert.equal(parseMergePolicy({ resolvedBotThreads: { goneMarker: '' } }), undefined);
  assert.equal(parseMergePolicy({ resolvedBotThreads: false }), undefined);
});

test('an answered bot thread is told apart from an open one: only a person can resolve it now', () => {
  const policy = { resolvedBotThreads: true } as const;
  const openThreads = [
    { author: SAKUGA, lastAuthor: SAKUGA },
    { author: SAKUGA, lastAuthor: 'sakuga-agent[bot]' },
    { author: SAKUGA, lastAuthor: 'mathieu' },
    { author: SAKUGA, lastAuthor: 'coderabbitai[bot]' },
  ];
  assert.deepEqual(policyMisses(policy, facts({ openThreads, author: 'sakuga-agent[bot]' })), [
    { rule: 'resolvedBotThreads', note: '3 open bot threads' },
    { rule: 'resolvedBotThreads', note: '1 answered bot thread to resolve' },
  ]);
  // On a pull request of a person, the agent answers only if the settings list it.
  assert.deepEqual(policyMisses(policy, facts({ openThreads: [openThreads[1]!], author: 'mathieu' })), [
    { rule: 'resolvedBotThreads', note: '1 open bot thread' },
  ]);
  const agents = ['sakuga-agent[bot]'];
  assert.deepEqual(policyMisses(policy, facts({ openThreads: [openThreads[1]!], author: 'mathieu', agents })), [
    { rule: 'resolvedBotThreads', note: '1 answered bot thread to resolve' },
  ]);
  // Each case on its own thread: the reply of mathieu answers only on his own pull request.
  const byMathieu = [openThreads[2]!];
  assert.deepEqual(botThreads(true, { openThreads: byMathieu, author: 'mathieu' }), { open: 0, answered: 1 });
  assert.deepEqual(botThreads(true, { openThreads: byMathieu, author: 'sakuga-agent[bot]' }), { open: 1, answered: 0 });
  const byAgent = [openThreads[1]!];
  assert.deepEqual(botThreads(true, { openThreads: byAgent, author: 'sakuga-agent[bot]' }), { open: 0, answered: 1 });
  assert.deepEqual(botThreads(true, { openThreads: byAgent, author: 'mathieu' }), { open: 1, answered: 0 });
});
