import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionsOf, CODERABBIT, COPILOT, GREPTILE, requestText } from './actions.js';
import { activeBots, allBots, assignKeys, checkBotField, customBotOf, plannedRetries, toBot } from './bots.js';
import type { Reviewer } from './reviewers.js';
import { DEFAULT_SETTINGS, parseSettings, type Settings } from './settings.js';

const SOURCERY = {
  name: 'Sourcery',
  key: 's',
  logins: ['sourcery-ai[bot]'],
  mention: '@sourcery-ai',
  commands: ['review', 'summary'],
};
const quota = (login: string, refusedAt: string, until?: string): Reviewer => ({
  login,
  name: login,
  bot: true,
  status: 'quota',
  reviews: 0,
  refusedAt: new Date(refusedAt),
  ...(until && { until: new Date(until) }),
});

test('a bot that the settings turn off leaves the bar, and a custom bot joins it', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, bots: { greptile: { enabled: false } }, customBots: [SOURCERY] };
  assert.deepEqual(
    activeBots(settings).map((bot) => bot.name),
    ['CodeRabbit', 'Copilot', 'PR-Agent', 'Sourcery'],
  );
  assert.equal(allBots(settings).length, 5);
});

test('a custom bot posts its commands with its mention, or asks GitHub for a review', () => {
  const bot = toBot(SOURCERY);
  assert.deepEqual(
    actionsOf(bot).map((action) => [action.key, requestText(action.request!)]),
    [
      ['r', '@sourcery-ai review'],
      ['s', '@sourcery-ai summary'],
    ],
  );
  const reviewer = toBot({ ...SOURCERY, mention: undefined, reviewer: 'sourcery-ai' } as never);
  assert.deepEqual(
    actionsOf(reviewer).map((action) => requestText(action.request!)),
    ['review request to Sourcery'],
  );
});

test('each command gets a free key that no other use takes', () => {
  assert.deepEqual(
    assignKeys(['review', 'rerun', 'open', 'help']).map(({ key }) => key),
    ['r', 'e', 'p', 'l'],
  );
});

test('the form refuses a used name, a used or reserved key, no login and a mention of @copilot', () => {
  const bots = allBots(DEFAULT_SETTINGS);
  assert.match(checkBotField(0, 'greptile', bots)!, /already exists/);
  assert.equal(checkBotField(0, 'Sourcery', bots), undefined);
  assert.match(checkBotField(1, 'g', bots)!, /Greptile uses/);
  assert.match(checkBotField(1, 'o', bots)!, /another use/);
  assert.match(checkBotField(1, 'ab', bots)!, /one letter/);
  assert.equal(checkBotField(1, 'S', bots), undefined);
  assert.match(checkBotField(2, ' , ', bots)!, /one login/);
  assert.match(checkBotField(3, '@Copilot', bots)!, /coding agent/);
  assert.equal(checkBotField(3, '/', bots), undefined);
  assert.match(checkBotField(3, '/review', bots)!, /alone/);
});

test('the form gives a bot with a mention, a slash command or a review request', () => {
  assert.deepEqual(customBotOf(['Sourcery', 'S', 'sourcery-ai[bot]', '@sourcery-ai', '']), {
    name: 'Sourcery',
    key: 's',
    logins: ['sourcery-ai[bot]'],
    mention: '@sourcery-ai',
    commands: ['review'],
  });
  assert.equal(customBotOf(['Agent', 'a', 'agent[bot]', '/', 'review, ask']).mention, undefined);
  assert.equal(customBotOf(['Agent', 'a', 'agent[bot]', '/', 'review, ask']).reviewer, undefined);
  assert.equal(customBotOf(['Bob', 'b', 'bob[bot]', 'bob', '']).reviewer, 'bob');
});

test('a bot with retries on gets one retry at the return time of its quota, or 1 hour after the refusal', () => {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    bots: { copilot: { autoRetry: true }, greptile: { autoRetry: true } },
  };
  const reviewers = [
    quota('copilot-pull-request-reviewer[bot]', '2026-10-12T10:00:00Z'),
    quota('greptile-apps[bot]', '2026-10-12T10:00:00Z', '2026-10-12T10:20:00Z'),
  ];
  assert.deepEqual(
    plannedRetries(reviewers, [CODERABBIT, GREPTILE, COPILOT], settings).map(({ bot, at, refusal }) => [
      bot.name,
      at.toISOString(),
      refusal,
    ]),
    [
      ['Greptile', '2026-10-12T10:20:00.000Z', '2026-10-12T10:00:00.000Z'],
      ['Copilot', '2026-10-12T11:00:00.000Z', '2026-10-12T10:00:00.000Z'],
    ],
  );
});

test('a bot gets no retry by default, and CodeRabbit keeps its own clock', () => {
  const reviewers = [
    quota('greptile-apps[bot]', '2026-10-12T10:00:00Z'),
    quota('coderabbitai[bot]', '2026-10-12T10:00:00Z'),
  ];
  assert.deepEqual(plannedRetries(reviewers, [CODERABBIT, GREPTILE], DEFAULT_SETTINGS), []);
});

test('the settings file keeps the valid switches and custom bots, and drops the rest', () => {
  const settings = parseSettings({
    bots: { coderabbit: { enabled: false, autoRetry: 'yes' }, greptile: 3 },
    customBots: [
      SOURCERY,
      { ...SOURCERY, key: 'z' },
      { ...SOURCERY, name: 'Clash', key: 'g' },
      { ...SOURCERY, name: 'Twin', key: 's' },
      { ...SOURCERY, name: 'Greptile', key: 'y' },
      { ...SOURCERY, name: 'Agent', key: 'x', mention: '@Copilot' },
      { ...SOURCERY, name: 'Opener', key: 'o' },
      { name: 'NoLogin', key: 'x', logins: [], commands: ['review'] },
      'broken',
    ],
  });
  assert.deepEqual(settings.bots, { coderabbit: { enabled: false } });
  assert.deepEqual(settings.customBots, [SOURCERY]);
});
