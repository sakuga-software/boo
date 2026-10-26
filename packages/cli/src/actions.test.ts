import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionForKey,
  actionsOf,
  BOT_BAR_WIDTH,
  BOTS,
  CODERABBIT,
  fillPrompt,
  COPILOT,
  GREPTILE,
  parentOf,
  PR_AGENT,
  moveSelection,
  refusal,
  requestText,
  reselect,
  RESERVED_KEYS,
  type Mode,
} from './actions.js';

const LEVELS: readonly Mode[] = ['main', 'bots', ...BOTS];
const keysAt = (mode: Mode) =>
  mode === 'bots' ? BOTS.map((bot) => bot.key) : actionsOf(mode).map((action) => action.key);

test('only merge uses m, the last byte of a mouse report, and it always asks for a confirmation', () => {
  assert.deepEqual(
    LEVELS.map((mode) => keysAt(mode).filter((key) => key.toLowerCase() === 'm')),
    [['m'], [], [], [], [], []],
  );
  assert.equal(actionForKey('m')!.merge, true);
});

test('each key maps to one action or one bot at its level', () => {
  for (const mode of LEVELS) assert.equal(new Set(keysAt(mode)).size, keysAt(mode).length);
  assert.equal(actionForKey('a', CODERABBIT)?.request?.command, 'approve');
  assert.equal(actionForKey('x', CODERABBIT), undefined);
});

test('a key of a bot works only in the menu of that bot', () => {
  assert.equal(actionForKey('r', CODERABBIT)?.request?.bot.id, CODERABBIT.id);
  assert.equal(actionForKey('r', PR_AGENT)?.request?.bot.id, PR_AGENT.id);
  assert.equal(actionForKey('a', GREPTILE), undefined);
  assert.equal(actionForKey('r'), undefined);
  assert.equal(actionForKey('r', 'bots'), undefined);
});

test('open and merge work at every level, and the levels go up one at a time', () => {
  for (const mode of LEVELS)
    assert.deepEqual([actionForKey('o', mode)?.label, actionForKey('m', mode)?.label], ['open', 'merge']);
  assert.deepEqual([parentOf(CODERABBIT), parentOf('bots'), parentOf('main')], ['bots', 'main', 'main']);
});

test('a bot with a mention gets a bare command, and Copilot gets a review request', () => {
  assert.equal(requestText(actionForKey('f', CODERABBIT)!.request!), '@coderabbitai full review');
  assert.equal(requestText(actionForKey('r', GREPTILE)!.request!), '@greptileai review');
  assert.equal(requestText(actionForKey('r', COPILOT)!.request!), 'review request to Copilot');
  assert.equal(COPILOT.mention, undefined);
});

test('the bot levels show their labels in a terminal of 80 columns', () => {
  assert.ok(BOT_BAR_WIDTH <= 80 - 2);
});

test('the keys that the list, the prompt, the panel and the main set use are free at the bot levels', () => {
  const taken = [...RESERVED_KEYS];
  assert.deepEqual(
    LEVELS.slice(1)
      .flatMap(keysAt)
      .filter((key) => taken.includes(key)),
    [],
  );
  assert.deepEqual(
    keysAt('main').filter((key) => taken.slice(0, 8).includes(key)),
    [],
  );
});

test('open stays available on a merged pull request, a command does not', () => {
  const open = actionForKey('o')!;
  const approve = actionForKey('a', CODERABBIT)!;
  assert.equal(refusal(open, { left: true, dryRun: false }), null);
  assert.match(refusal(approve, { left: true, dryRun: false })!, /no longer open/);
  assert.match(refusal(approve, { left: false, dryRun: true })!, /dry run/);
  assert.equal(refusal(approve, { left: false, dryRun: false }), null);
});

test('a bot command needs the bot on the pull request, open, merge and Copilot do not', () => {
  const target = { left: false, dryRun: false, reviewers: [{ login: 'greptile-apps[bot]' }] };
  assert.match(refusal(actionForKey('r', CODERABBIT)!, target)!, /CodeRabbit does not review/);
  assert.equal(refusal(actionForKey('r', GREPTILE)!, target), null);
  assert.equal(refusal(actionForKey('r', COPILOT)!, target), null);
  assert.equal(refusal(actionForKey('o')!, target), null);
  assert.equal(refusal(actionForKey('m')!, target), null);
});

test('PR-Agent takes a slash command, on a pull request where an install of it posted a review', () => {
  assert.equal(requestText(actionForKey('r', PR_AGENT)!.request!), '/review');
  assert.equal(requestText(actionForKey('i', PR_AGENT)!.request!), '/improve');
  const target = { left: false, dryRun: false, reviewers: [{ login: 'sakuga-review[bot]', prAgent: true }] };
  assert.equal(refusal(actionForKey('r', PR_AGENT)!, target), null);
  assert.match(
    refusal(actionForKey('i', PR_AGENT)!, { ...target, reviewers: [{ login: 'sakuga-review[bot]' }] })!,
    /PR-Agent does not review/,
  );
});

test('a bot command waits for no reviewer list before the first fetch', () => {
  assert.equal(refusal(actionForKey('r', GREPTILE)!, { left: false, dryRun: false }), null);
});

test('the selection follows the key and stops at the ends', () => {
  const keys = ['a#1', 'a#2', 'a#3'];
  assert.equal(moveSelection(keys, undefined, 1), 'a#1');
  assert.equal(moveSelection(keys, 'a#2', 1), 'a#3');
  assert.equal(moveSelection(keys, 'a#3', 1), 'a#3');
  assert.equal(moveSelection(keys, 'a#1', -1), 'a#1');
  assert.equal(moveSelection(['a#0', ...keys], 'a#2', 1), 'a#3');
  assert.equal(moveSelection([], 'a#1', 1), undefined);
});

test('a visible selection stays', () => {
  assert.equal(reselect(['a', 'b', 'c'], ['a', 'c'], 'c'), 'c');
});

test('a hidden selection goes to the next visible row', () => {
  assert.equal(reselect(['a', 'b', 'c', 'd'], ['a', 'd'], 'b'), 'd');
});

test('a hidden selection at the end goes to the previous visible row', () => {
  assert.equal(reselect(['a', 'b', 'c'], ['a'], 'c'), 'a');
});

test('no visible row gives no selection', () => {
  assert.equal(reselect(['a'], [], 'a'), undefined);
  assert.equal(reselect(['a', 'b'], ['b'], undefined), 'b');
});

test('merge is refused on a pull request that is no longer open, and in a dry run', () => {
  const merge = actionForKey('m')!;
  assert.match(refusal(merge, { left: true, dryRun: false })!, /no longer open/);
  assert.match(refusal(merge, { left: false, dryRun: true })!, /dry run/);
  assert.equal(refusal(merge, { left: false, dryRun: false }), null);
});

test('the agent level sends a command only to a pull request with a local session', () => {
  const fix = actionForKey('f', 'agent')!;
  assert.equal(fix.agent?.label, 'fix');
  assert.equal(parentOf('agent'), 'main');
  assert.match(refusal(fix, { left: false, dryRun: false })!, /no Claude Code session/);
  assert.equal(refusal(fix, { left: false, dryRun: false, local: true }), null);
  assert.equal(refusal(fix, { left: false, dryRun: true, local: true }), 'dry run: the tool sends nothing');
  assert.deepEqual(
    actionsOf('agent').map((action) => action.key),
    ['b', 'r', 'f', 't', 'w'],
  );
});

test('the agent level opens a cloud session online, with no local session and even in a dry run', () => {
  const open = actionForKey('w', 'agent')!;
  assert.equal(open.openSession, true);
  assert.equal(refusal(open, { left: false, dryRun: true, cloudSession: true }), null);
  assert.equal(refusal(open, { left: true, dryRun: false, cloudSession: true }), null);
  assert.equal(refusal(open, { left: false, dryRun: false, local: true }), 'this pull request links no cloud session');
});

test('a prompt takes the values of the pull request', () => {
  assert.equal(
    fillPrompt('Rebase {branch} of {url} on {base}, {other}.', { url: 'u', branch: 'feat/x', base: 'main' }),
    'Rebase feat/x of u on main, {other}.',
  );
});
