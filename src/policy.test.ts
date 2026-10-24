import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment, Review } from './decide.js';
import { globToRegExp, parseMergePolicy, policyMisses, type PolicyFacts } from './policy.js';
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
  assert.deepEqual(
    parseMergePolicy({
      minScore: { reviewer: 'sakuga-review', score: 4, onHead: true },
      requireProof: '\\.gif',
      resolvedBotThreads: true,
      ownerOnly: { paths: ['**/auth/**', 3], owner: '@me' },
    }),
    {
      minScore: { reviewer: 'sakuga-review', score: 4, onHead: true },
      requireProof: '\\.gif',
      resolvedBotThreads: true,
      ownerOnly: { paths: ['**/auth/**'], owner: '@me' },
    },
  );
  assert.deepEqual(
    parseSettings({ mergePolicy: { minScore: { reviewer: 'x', score: 'high' } } }).mergePolicy,
    undefined,
  );
});
