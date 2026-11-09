import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayConfig } from './config';

test('the relay comes from expo.extra, and the hosted relay is the default', () => {
  assert.deepEqual(relayConfig(undefined), { relayUrl: 'https://boo-relay.sakuga.dev' });
  assert.deepEqual(relayConfig({ relayUrl: '  ' }), { relayUrl: 'https://boo-relay.sakuga.dev' });
  assert.deepEqual(relayConfig({ relayUrl: 'http://localhost:4611', githubUrl: 'http://localhost:4610' }), {
    relayUrl: 'http://localhost:4611',
    githubUrl: 'http://localhost:4610',
  });
  assert.deepEqual(relayConfig({ relayUrl: 42 }), { relayUrl: 'https://boo-relay.sakuga.dev' });
});
