import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUSH_STATES } from '@sakuga-software/boo-core/settings';
import type { WatchConfig } from './remote';
import { authorsSummary, hostOf, orgSummary, PUSH_ROWS, reposSummary, withPush } from './summary';

test('the rows of what the relay follows say the organization, the authors and the repositories', () => {
  assert.equal(orgSummary(''), 'every account');
  assert.equal(orgSummary('sakuga-software'), 'sakuga-software');
  assert.equal(authorsSummary(['@me', 'app/sakuga-agent']), '@me · app/sakuga-agent');
  assert.equal(reposSummary(undefined, 'acme'), 'all of the organization');
  assert.equal(reposSummary([], ''), 'all repositories');
  assert.equal(reposSummary(['acme/web'], 'acme'), 'acme/web');
  assert.equal(reposSummary(['acme/web', 'acme/api'], 'acme'), '2 repositories');
});

test('the switches name every push state of core once', () => {
  assert.deepEqual(PUSH_ROWS.map(({ key }) => key).sort(), PUSH_STATES.map(({ key }) => key).sort());
});

test('a switch keeps only the states turned off, and the other settings as they came', () => {
  // Only the keys that the switch reads: the other settings go back as they came.
  const config: WatchConfig = {
    org: 'acme',
    settings: { authors: ['@me'], push: { merged: false } } as WatchConfig['settings'],
  };
  assert.deepEqual(withPush(config, 'ready', false), {
    org: 'acme',
    settings: { authors: ['@me'], push: { merged: false, ready: false } },
  });
  assert.deepEqual(withPush(config, 'merged', true), { org: 'acme', settings: { authors: ['@me'] } });
});

test('the account card shows the host of the relay', () => {
  assert.equal(hostOf('https://boo-relay.sakuga.dev'), 'boo-relay.sakuga.dev');
  assert.equal(hostOf('not a url'), 'not a url');
});
