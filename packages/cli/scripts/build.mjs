// Builds dist/ with esbuild. The modules of @sakuga-software/boo-core go into the build: core is a
// private package, and npm installs only the dependencies of package.json. The dependencies stay
// outside the build, as imports.
//
// cli.ts sets NODE_ENV and then imports main.js. Thus main.tsx is a second entry point, in its own
// file: a single file would load React before cli.ts sets NODE_ENV.
//
// node scripts/build.mjs
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const { dependencies = {} } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

rmSync(path.join(root, 'dist'), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts', 'src/main.tsx'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  jsx: 'automatic',
  // A dependency and its subpaths, for example "ink" and "react/jsx-runtime".
  external: Object.keys(dependencies).flatMap((name) => [name, `${name}/*`]),
  logLevel: 'warning',
});
chmodSync(path.join(root, 'dist', 'cli.js'), 0o755);
