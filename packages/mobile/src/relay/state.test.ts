import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterCheck, EXPIRED_NOTICE, markSigningOut, NO_ANSWER_NOTICE, type RelayState } from './state';

const connection = { url: 'https://relay.test', session: 's', login: 'alice' };
const INSTALL = 'https://github.com/apps/boo-relay/installations/new';
const signedIn: RelayState = { status: 'signedIn', connection, installUrl: INSTALL };

test('a check that reads an installation removes the install link, and one that reads none shows it', () => {
  assert.deepEqual(afterCheck(signedIn, connection, { status: 'read' }, true), { status: 'signedIn', connection });
  assert.deepEqual(
    afterCheck({ status: 'signedIn', connection }, connection, { status: 'read', installUrl: INSTALL }, false),
    signedIn,
  );
});

test('a relay that does not answer gets a notice only when the person asked for the check', () => {
  assert.deepEqual(afterCheck(signedIn, connection, { status: 'unknown' }, true), {
    ...signedIn,
    notice: NO_ANSWER_NOTICE,
  });
  assert.equal(afterCheck(signedIn, connection, { status: 'unknown' }, false), signedIn);
  // The next answer removes the notice.
  const noticed: RelayState = { ...signedIn, notice: NO_ANSWER_NOTICE };
  assert.deepEqual(afterCheck(noticed, connection, { status: 'read', installUrl: INSTALL }, true), signedIn);
});

test('an expired session signs out, and a check of another session changes nothing', () => {
  assert.deepEqual(afterCheck(signedIn, connection, { status: 'expired' }, false), {
    status: 'signedOut',
    notice: EXPIRED_NOTICE,
  });
  const other = { ...connection, session: 'other' };
  assert.equal(afterCheck(signedIn, other, { status: 'expired' }, false), signedIn);
  const signedOut: RelayState = { status: 'signedOut' };
  assert.equal(afterCheck(signedOut, connection, { status: 'read' }, false), signedOut);
});

test('a check during the sign-out keeps the sign-out, and the sign-out marks the current screen', () => {
  const leaving = markSigningOut(signedIn);
  assert.deepEqual(leaving, { ...signedIn, signingOut: true });
  assert.deepEqual(afterCheck(leaving, connection, { status: 'read' }, false), {
    status: 'signedIn',
    connection,
    signingOut: true,
  });
  const signedOut: RelayState = { status: 'signedOut' };
  assert.equal(markSigningOut(signedOut), signedOut);
});
