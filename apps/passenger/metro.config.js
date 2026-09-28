// Metro config for a pnpm monorepo: pnpm hoists via symlinks, and workspace
// packages (@yatri/shared, @yatri/types) live outside this app's node_modules,
// so Metro needs to watch the repo root and resolve symlinks itself.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;
// NOTE: hierarchical lookup must stay enabled (the default) for a pnpm
// monorepo. pnpm nests real packages inside a per-dependency virtual store
// directory (node_modules/.pnpm/<pkg>@<version>/node_modules/...), and a
// package's own dependencies are only reachable by walking up from its
// resolved (symlink-followed) real path — which is exactly what disabling
// hierarchical lookup turns off. With it disabled, anything nested more
// than one level deep (e.g. expo's own dependency on expo-modules-core)
// fails to resolve.

module.exports = config;
