import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSettings } from '@sakuga-software/boo-core/settings';
import { configOf, formOf, unchanged } from './form';
import type { WatchConfig } from './remote';

const ALL_ON = {
  ready: true,
  changesRequested: true,
  checksFailing: true,
  conflicts: true,
  merged: true,
  stalled: true,
};

const current: WatchConfig = {
  org: 'acme',
  settings: parseSettings({
    authors: ['@me', 'bob'],
    repos: ['acme/api'],
    drafts: 'show',
    mergePolicy: { resolvedBotThreads: true, answeredReviewRequests: true },
    customBots: [{ name: 'Lint bot', key: 'z', logins: ['lint[bot]'], commands: ['/lint'] }],
  }),
};

test('the fields show the organization, then one author and one repository per line', () => {
  const { push: _push, ...fields } = formOf(current);
  assert.deepEqual(fields, { org: 'acme', authors: '@me\nbob', repos: 'acme/api' });
  const { push: _none, ...empty } = formOf({ org: '', settings: parseSettings(undefined) });
  assert.deepEqual(empty, { org: '', authors: '@me', repos: '' });
});

test('a save changes the organization, the authors and the repositories, and keeps every other setting', () => {
  const next = configOf(
    { org: ' @acme ', authors: '@me, carol\n\ncarol app/dependabot', repos: 'web\nother/lib', push: ALL_ON },
    current,
  );
  assert.equal(next.error, undefined);
  const { config } = next as { config: WatchConfig };
  assert.equal(config.org, 'acme');
  assert.deepEqual(config.settings.authors, ['@me', 'carol', 'app/dependabot']);
  assert.deepEqual(config.settings.repos, ['acme/web', 'other/lib']);
  // The fields that the screen does not edit go back as they came: the relay replaces the whole file.
  assert.equal(config.settings.drafts, 'show');
  assert.ok(current.settings.mergePolicy);
  assert.deepEqual(config.settings.mergePolicy, current.settings.mergePolicy);
  assert.equal(config.settings.customBots.length, 1);
  assert.deepEqual(config.settings.customBots, current.settings.customBots);
});

test('no repository removes the list, so the relay follows every repository', () => {
  const next = configOf({ org: '', authors: '@me', repos: '  \n', push: ALL_ON }, current);
  assert.ok(next.error === undefined);
  assert.equal('repos' in next.config.settings, false);
  assert.equal(next.config.org, '');
});

test('a wrong organization, no author or a wrong repository gives the problem, and nothing to save', () => {
  const form = formOf(current);
  assert.match(configOf({ ...form, org: 'not an org!' }, current).error!, /not the login/);
  assert.match(configOf({ ...form, org: '-acme' }, current).error!, /not the login/);
  assert.match(configOf({ ...form, authors: ' , \n' }, current).error!, /one author or more/);
  assert.match(configOf({ ...form, repos: 'acme/a/b' }, current).error!, /"acme\/a\/b" is not a repository/);
  assert.match(configOf({ ...form, repos: 'acme/..' }, current).error!, /is not a repository/);
  // With every account, a name with no owner has no owner to take.
  assert.match(configOf({ ...form, org: '', repos: 'api' }, current).error!, /"api" needs an owner/);
});

test('Save stays off until a field gives another config', () => {
  assert.equal(unchanged(formOf(current), current), true);
  assert.equal(unchanged({ ...formOf(current), authors: 'bob, @me' }, current), false);
  // The same config written another way.
  assert.equal(unchanged({ ...formOf(current), authors: '@me bob', repos: 'api' }, current), true);
  assert.equal(unchanged({ ...formOf(current), org: 'bad org' }, current), false);
});

test('the push switches show the settings of the relay: a state that the key does not name is on', () => {
  assert.deepEqual(formOf(current).push, ALL_ON);
  const some = { org: 'acme', settings: parseSettings({ push: { merged: false, ready: true } }) };
  assert.deepEqual(formOf(some).push, { ...ALL_ON, merged: false });
});

test('a save sends only the states turned off, and no key when every state is on', () => {
  const form = { ...formOf(current), push: { ...ALL_ON, merged: false, stalled: false } };
  const next = configOf(form, current) as { config: WatchConfig };
  assert.deepEqual(next.config.settings.push, { merged: false, stalled: false });
  assert.equal(unchanged(form, current), false);
  const back = configOf({ ...form, push: ALL_ON }, next.config) as { config: WatchConfig };
  assert.equal('push' in back.config.settings, false);
  assert.equal(unchanged({ ...form, push: ALL_ON }, current), true);
});
