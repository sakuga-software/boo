import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const config = createRequire(import.meta.url)('../metro.config.js') as {
  resolver: { resolveRequest: (context: Context, name: string, platform: string | null) => unknown };
};
interface Context {
  originModulePath: string;
  resolveRequest: (context: Context, name: string, platform: string | null) => unknown;
}

const core = resolve(here, '../../core/src');
const asked: string[] = [];
const context = (origin: string): Context => ({
  originModulePath: origin,
  resolveRequest: (_context, name) => {
    asked.push(name);
    return { type: 'sourceFile', filePath: name };
  },
});

test('a relative .js import of core reaches Metro with no extension, so it finds the .ts file', () => {
  asked.length = 0;
  const { resolveRequest } = config.resolver;
  resolveRequest(context(join(core, 'report.ts')), './bots.js', 'ios');
  resolveRequest(context(join(core, 'report.ts')), '../core/src/theme.js', 'ios');
  assert.deepEqual(asked, ['./bots', '../core/src/theme']);
});

test('any other import goes to Metro as it is', () => {
  asked.length = 0;
  const { resolveRequest } = config.resolver;
  // A package, a file of the app, and a file next to core that is not in it.
  resolveRequest(context(join(core, 'report.ts')), 'react-native', 'ios');
  resolveRequest(context(join(here, 'app/index.tsx')), './vendor.js', 'ios');
  resolveRequest(context(resolve(core, '../scripts/x.ts')), './y.js', 'ios');
  resolveRequest(context(`${core}-copy/a.ts`), './b.js', 'ios');
  assert.deepEqual(asked, ['react-native', './vendor.js', './y.js', './b.js']);
});
