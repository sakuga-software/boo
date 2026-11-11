import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountAvatar, agentAvatar, monogram } from './avatars';
import { shortAgo } from './time';

test('the bots of the mockup keep their letters and colors, by their login on GitHub', () => {
  assert.deepEqual(
    ['copilot-pull-request-reviewer[bot]', 'greptile-apps[bot]', 'coderabbitai[bot]', 'sakuga-review[bot]'].map(
      (login) => accountAvatar(login, 'dark').mono,
    ),
    ['Co', 'Gr', 'CR', 'SR'],
  );
  assert.equal(accountAvatar('greptile-apps[bot]', 'light').bg, '#D9F0E3');
  assert.equal(accountAvatar('coderabbitai[bot]', 'dark').name, 'coderabbit');
});

test('another account gets two letters and the same color each time', () => {
  assert.equal(monogram('kento-review'), 'KR');
  assert.equal(monogram('mheaus'), 'Mh');
  assert.deepEqual(accountAvatar('kento-review[bot]', 'dark'), accountAvatar('kento-review[bot]', 'dark'));
  assert.equal(accountAvatar('kento-review[bot]', 'dark').name, 'kento-review');
});

test('Claude gets its mark, another agent its name', () => {
  assert.deepEqual(agentAvatar('claude', 'dark', '#D77757', 'well'), {
    mono: '',
    claude: true,
    bg: 'well',
    fg: '#D77757',
    name: 'Claude',
  });
  assert.equal(agentAvatar('copilot', 'dark', '', '').mono, 'Co');
});

test('a short age reads as on the rows', () => {
  const now = new Date(2026, 10, 10, 12, 0);
  const before = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  assert.deepEqual(
    [0, 42, 60, 60 * 30, -3].map((minutes) => shortAgo(now, before(minutes))),
    ['now', '42m', '1h', '1d', 'now'],
  );
});
