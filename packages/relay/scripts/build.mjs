// Builds dist/main.js with esbuild. The modules of @sakuga-software/boo-core go into the build, so
// the image carries only Node and this file: the relay has no runtime dependency.
//
// node scripts/build.mjs
import { rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
});
