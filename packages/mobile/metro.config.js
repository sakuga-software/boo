// pnpm keeps the packages of the workspace outside this folder, as symbolic links. Metro must watch
// the root of the workspace, and resolve modules from this folder first, then from the root.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Core is TypeScript for Node: its relative imports end with `.js` (NodeNext), and its files are
// `.ts`. Metro looks for the `.js` file: it gets the `.ts` file of the same name in its place.
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = resolveRequest ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // Not a TypeScript file: the `.js` file itself.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
