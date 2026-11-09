import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathOf } from './taps';

test('a tap opens the pull request that the relay names, or the list', () => {
  assert.equal(pathOf({ url: 'boo://pull/acme/web/12' }), '/pull/acme/web/12');
  assert.equal(pathOf({ url: 'boo://pull/acme/web%20app/3/', pr: 'acme/web app#3' }), undefined);
  assert.equal(pathOf({ url: 'boo://pull/my-org/my.repo_2/7' }), '/pull/my-org/my.repo_2/7');
  assert.equal(pathOf({ url: 'boo://' }), '/');
});

test('any other value opens nothing', () => {
  for (const data of [
    undefined,
    null,
    'boo://pull/acme/web/12',
    {},
    { url: 3 },
    { url: 'https://evil.test/pull/acme/web/12' },
    { url: 'boo://settings' },
    { url: 'boo://pull/acme/web' },
    { url: 'boo://pull/acme/web/0' },
    { url: 'boo://pull/acme/web/12/files' },
    { url: 'boo://pull/../web/12' },
    { url: 'boo://pull/acme/%2e%2e/12' },
    { url: 'boo://pull/acme/%E0%A4%A/12' },
    { url: 'boo://pull/acme/we$b/12' },
  ])
    assert.equal(pathOf(data), undefined, JSON.stringify(data));
});
