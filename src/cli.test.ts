import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('--json refuses --watch before it reads GitHub', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--json', '--watch'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--json prints the state once/);
  assert.equal(run.stdout, '');
});
