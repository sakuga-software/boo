import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment, Review } from './decide.js';
import { globToRegExp, parseMergePolicy, policyMisses, unansweredRequests, type PolicyFacts } from './policy.js';
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

test('the proof can be in the description or in a comment', () => {
  const policy = { requireProof: '\\.(gif|webm|mp4)|No /tfp:' };
  assert.deepEqual(policyMisses(policy, facts({ body: 'A change.' })), [{ rule: 'requireProof', note: 'no proof' }]);
  assert.deepEqual(policyMisses(policy, facts({ body: '![run](https://x/run.gif)' })), []);
  assert.deepEqual(policyMisses(policy, facts({ comments: [comment('mathieu', 'No /tfp: no page', 1)] })), []);
});

test('an open thread of a bot misses the rule, an open thread of a person does not', () => {
  const policy = { resolvedBotThreads: true };
  assert.deepEqual(policyMisses(policy, facts({ openThreads: ['alice'] })), []);
  assert.deepEqual(policyMisses(policy, facts({ openThreads: ['alice', 'coderabbitai[bot]', 'Copilot'] })), [
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
});
