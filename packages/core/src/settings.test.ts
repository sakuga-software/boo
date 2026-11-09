import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSettings, pushOn } from './settings.js';

test('the push switches keep only the known states with a boolean value', () => {
  const settings = parseSettings({ push: { merged: false, ready: true, stalled: 'no', other: false } });
  assert.deepEqual(settings.push, { ready: true, merged: false });
  assert.equal(pushOn(settings, 'merged'), false);
  assert.equal(pushOn(settings, 'ready'), true);
  // A state that the settings do not name is on.
  assert.equal(pushOn(settings, 'conflicts'), true);
});

test('settings with no valid push switch have no push key, and every state is on', () => {
  for (const push of [undefined, null, [], 'off', { other: false }, { merged: 'no' }]) {
    const settings = parseSettings({ push });
    assert.equal('push' in settings, false);
    assert.equal(pushOn(settings, 'merged'), true);
  }
});
