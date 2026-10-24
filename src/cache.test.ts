import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cacheDir, DiskCache } from './cache.js';
import { lowOnPoints } from './github.js';

const now = Date.parse('2026-10-24T12:00:00Z');

test('a value younger than the maximum age reads back, an older one does not', async () => {
  const cache = new DiskCache(await mkdtemp(join(tmpdir(), 'boo-cache-')));
  await cache.set('pr-acme/web#1', { head: 'abc' }, now);
  assert.deepEqual(await cache.get('pr-acme/web#1', 30_000, now + 29_000), { value: { head: 'abc' }, at: now });
  assert.equal(await cache.get('pr-acme/web#1', 30_000, now + 30_000), undefined);
  assert.equal(await cache.get('pr-acme/web#1', 0, now), undefined);
});

test('a missing, broken or future entry is a miss, and a write leaves no temporary file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boo-cache-'));
  const cache = new DiskCache(dir);
  assert.equal(await cache.get('missing', 30_000, now), undefined);
  await writeFile(join(dir, 'broken.json'), '{');
  assert.equal(await cache.get('broken', 30_000, now), undefined);
  await cache.set('future', 1, now + 60_000);
  assert.equal(await cache.get('future', 30_000, now), undefined);
  await Promise.all([1, 2, 3].map((value) => cache.set('pr-acme/web#2', value, now)));
  assert.deepEqual((await readdir(dir)).sort(), ['broken.json', 'future.json', 'pr-acme_web_2.json']);
});

test('a write in a folder that cannot exist fails without an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boo-cache-'));
  await writeFile(join(dir, 'file'), '');
  const cache = new DiskCache(join(dir, 'file', 'boo'));
  await cache.set('key', 1, now);
  assert.equal(await cache.get('key', 30_000, now), undefined);
});

test('the cache folder follows XDG_CACHE_HOME', () => {
  assert.equal(cacheDir({ XDG_CACHE_HOME: '/tmp/xdg' }), '/tmp/xdg/boo');
});

test('the watch slows down below 20 % of the GraphQL points', () => {
  const rate = (remaining: number) => ({ limit: 5000, remaining, resetAt: '2026-10-24T13:00:00Z' });
  assert.equal(lowOnPoints(rate(999)), true);
  assert.equal(lowOnPoints(rate(1000)), false);
  assert.equal(lowOnPoints(undefined), false);
});

test('only the owner reads the cache folder and its entries', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'boo-cache-')), 'boo');
  await new DiskCache(dir).set('pr-acme/web#1', { head: 'abc' }, now);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'pr-acme_web_1.json'))).mode & 0o777, 0o600);
});
