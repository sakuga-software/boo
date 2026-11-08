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

test('--pr needs --json and a pull request it can read', () => {
  const alone = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--pr', 'boo#1'], { encoding: 'utf8' });
  assert.equal(alone.status, 2);
  assert.match(alone.stderr, /--pr reads one pull request for a script: it needs --json/);
  const wrong = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--json', '--pr', 'boo'], {
    encoding: 'utf8',
  });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /--pr takes owner\/repo#123/);
  assert.equal(wrong.stdout, '');
});

test('--snapshot refuses to run without --state', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--watch', '--events', '--snapshot'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--snapshot .* needs --state <file>/);
});

test('--state refuses a file that it cannot read, but not a missing one', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--watch', '--events', '--state', '/'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /cannot read the state in \//);
});
