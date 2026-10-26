import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('--json refuses --watch before it reads GitHub', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--json', '--watch'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--json prints the state once/);
  assert.equal(run.stdout, '');
});

test('--events refuses to run without --watch', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--events'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--events streams the changes: it needs --watch/);
});

test('-v and --version print the version of package.json', () => {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  for (const flag of ['-v', '--version']) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', flag], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout.trim(), version);
  }
});
