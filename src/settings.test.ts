import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, parseAuthors, parseSettings, saveSettings, settingsPath } from './settings.js';

test('the merged, closed and draft pull requests are hidden by default', () => {
  assert.deepEqual(
    [DEFAULT_SETTINGS.hideMerged, DEFAULT_SETTINGS.hideClosed, DEFAULT_SETTINGS.hideDrafts],
    [true, true, true],
  );
});

test('a stored value replaces its default, and an invalid or unknown value is ignored', () => {
  const settings = parseSettings({ hideMerged: false, checks: 'no', other: true });
  assert.equal(settings.hideMerged, false);
  assert.equal(settings.checks, true);
  assert.equal('other' in settings, false);
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings([]), DEFAULT_SETTINGS);
});

test('a missing or broken file gives the defaults, and a saved file reads back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boo-'));
  assert.deepEqual(await loadSettings(join(dir, 'missing.json')), DEFAULT_SETTINGS);
  await writeFile(join(dir, 'broken.json'), '{');
  assert.deepEqual(await loadSettings(join(dir, 'broken.json')), DEFAULT_SETTINGS);
  const path = join(dir, 'nested', 'settings.json');
  await saveSettings({ ...DEFAULT_SETTINGS, compact: true }, path);
  assert.equal((await loadSettings(path)).compact, true);
});

test('saves that start together end in call order and leave no temporary file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boo-'));
  const path = join(dir, 'settings.json');
  await Promise.all([true, false, true, false].map((compact) => saveSettings({ ...DEFAULT_SETTINGS, compact }, path)));
  assert.equal((await loadSettings(path)).compact, false);
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('a failed save does not stop the next save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boo-'));
  await writeFile(join(dir, 'file'), '');
  await assert.rejects(saveSettings(DEFAULT_SETTINGS, join(dir, 'file', 'settings.json')));
  const path = join(dir, 'settings.json');
  await saveSettings({ ...DEFAULT_SETTINGS, compact: true }, path);
  assert.equal((await loadSettings(path)).compact, true);
});

test('the settings file follows XDG_CONFIG_HOME', () => {
  assert.equal(settingsPath({ XDG_CONFIG_HOME: '/cfg' }), '/cfg/boo/settings.json');
});

test('the stored authors replace the default, and an invalid list keeps it', () => {
  assert.deepEqual(DEFAULT_SETTINGS.authors, ['@me']);
  assert.deepEqual(parseSettings({ authors: ['@me', ' app/my-agent ', '@me', '', 3] }).authors, [
    '@me',
    'app/my-agent',
  ]);
  assert.deepEqual(parseSettings({ authors: [] }).authors, ['@me']);
  assert.deepEqual(parseSettings({ authors: 'octocat' }).authors, ['@me']);
  assert.equal(parseAuthors(undefined), undefined);
});

test('a change of a setting keeps the stored authors', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'boo-')), 'settings.json');
  await saveSettings({ ...parseSettings({ authors: ['octocat', 'app/my-agent'] }), compact: true }, path);
  assert.deepEqual((await loadSettings(path)).authors, ['octocat', 'app/my-agent']);
});
