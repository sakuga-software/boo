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

// Core is TypeScript run as ES modules, so its relative imports name the output file: './bots.js' for
// bots.ts. Metro looks for that name as written. For a file of core, a relative '.js' import loses its
// extension, and Metro then finds the '.ts' file.
const coreSource = path.resolve(workspaceRoot, 'packages/core/src') + path.sep;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromCore = context.originModulePath.startsWith(coreSource);
  const name = fromCore && /^\.\.?\/.*\.js$/.test(moduleName) ? moduleName.slice(0, -3) : moduleName;
  return context.resolveRequest(context, name, platform);
};

module.exports = config;
