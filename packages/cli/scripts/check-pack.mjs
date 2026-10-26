// Checks what npm would publish, as a user gets it: build, `pnpm pack`, compare the files of the
// tarball with the modules of `src`, install the tarball in an empty folder, and run `boo` there.
// Nothing is published. The install reads the dependencies from the registry.
//
// node scripts/check-pack.mjs
// CHECK_PACK_DIR=<folder> node scripts/check-pack.mjs   # the folder of the work (default: the folder of the system)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const work = mkdtempSync(path.join(process.env.CHECK_PACK_DIR ?? os.tmpdir(), 'boo-pack-'));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
let failures = 0;

/** @param {string} message */
function fail(message) {
  failures += 1;
  console.error(`✗ ${message}`);
}

/** @param {string} message */
function pass(message) {
  console.log(`✓ ${message}`);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} options
 */
function run(command, args, { cwd, env = process.env }) {
  const done = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
  return { out: done.stdout ?? '', err: done.stderr ?? '', code: done.status ?? 1 };
}

execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
const tarballs = path.join(work, 'tarballs');
mkdirSync(tarballs);
execFileSync('pnpm', ['pack', '--pack-destination', tarballs], { cwd: root, stdio: 'ignore' });
const [tarballName] = readdirSync(tarballs);
if (!tarballName) throw new Error('pnpm pack wrote no tarball.');
const tarball = path.join(tarballs, tarballName);
console.log(`${tarballName}, ${Math.round(statSync(tarball).size / 1024)} kB`);

// A file of `dist` that no module of `src` builds is a left-over of an old build, or a test.
const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((file) => file.replace(/^package\//, ''))
  .sort();
const expected = [
  'LICENSE',
  'README.md',
  'package.json',
  ...readdirSync(path.join(root, 'src'))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => `dist/${file.replace(/\.tsx?$/, '.js')}`),
].sort();
const extra = files.filter((file) => !expected.includes(file));
const missing = expected.filter((file) => !files.includes(file));
if (extra.length > 0) fail(`the tarball has files that it must not publish: ${extra.join(', ')}`);
if (missing.length > 0) fail(`the tarball has no ${missing.join(', ')}`);
if (extra.length === 0 && missing.length === 0) pass(`the tarball holds the ${files.length} expected files`);

const cli = execFileSync('tar', ['-xOzf', tarball, 'package/dist/cli.js'], { encoding: 'utf8' });
if (cli.startsWith('#!/usr/bin/env node\n')) pass('dist/cli.js starts with the node shebang');
else fail('dist/cli.js has no "#!/usr/bin/env node" on its first line');

const project = path.join(work, 'project');
mkdirSync(project);
const install = run('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', tarball], { cwd: project });
if (install.code !== 0) {
  fail(`npm install of the tarball failed:\n${install.err}`);
  process.exit(1);
}
pass('npm installs the tarball in an empty folder');

// An empty config folder: the settings of the user of this machine must not change the result.
const env = { ...process.env, XDG_CONFIG_HOME: path.join(work, 'config') };
const boo = path.join(project, 'node_modules', '.bin', 'boo');

const versionRun = run(boo, ['--version'], { cwd: project, env });
if (versionRun.code === 0 && versionRun.out.trim() === version) pass(`boo --version prints ${version}`);
else
  fail(`boo --version gave exit ${versionRun.code} and "${versionRun.out.trim()}", not ${version}: ${versionRun.err}`);

const help = run(boo, ['--help'], { cwd: project, env });
if (help.code === 0 && help.out.includes('Usage')) pass('boo --help prints the usage');
else fail(`boo --help gave exit ${help.code}: ${help.err}`);

// `--events` with no `--watch` stops before it reads GitHub: the modules load, and the flags parse.
const events = run(boo, ['--events'], { cwd: project, env });
if (events.code === 2 && events.err.includes('it needs --watch')) pass('boo --events refuses to run without --watch');
else fail(`boo --events gave exit ${events.code}: ${events.err}`);

if (failures > 0) {
  console.error(`${failures} check(s) failed. The work is in ${work}.`);
  process.exit(1);
}
console.log(`The package is ready to publish. The work is in ${work}.`);
