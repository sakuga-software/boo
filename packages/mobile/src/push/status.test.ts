import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pushLine } from './status';

test('the settings screen says where the phone stands', () => {
  assert.match(pushLine({ status: 'registered', token: 'ExponentPushToken[a]' }), /gets a notification/);
  assert.match(pushLine({ status: 'denied' }), /settings of the system/);
  assert.equal(pushLine({ status: 'unavailable', reason: 'No EAS project.' }), 'No EAS project.');
  assert.equal(
    pushLine({ status: 'failed', message: 'The relay did not answer.' }),
    'This phone is not registered: The relay did not answer.',
  );
  assert.equal(pushLine({ status: 'idle' }), 'Registering this phone…');
  assert.equal(pushLine({ status: 'expired' }), 'Registering this phone…');
});
