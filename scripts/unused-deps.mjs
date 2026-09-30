// Lists dependencies a package declares but never imports. A first-pass audit, not a verdict: tooling
// that is only named in config files (expo plugins, babel presets, native modules) shows up here and
// needs a human look. Run from the repository root:  node scripts/unused-deps.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const roots = [
  'apps/api',
  'apps/admin',
  'apps/passenger',
  'apps/driver',
  'packages/types',
  'packages/shared',
  'packages/mobile-auth',
  'packages/mobile-location',
  'packages/mobile-ride',
  'packages/mobile-ui',
  'packages/config',
];
const SKIP = new Set(['node_modules', 'dist', '.next', '.expo', 'ios', 'android']);

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (SKIP.has(n)) return [];
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|jsx?|mjs|cjs|json|mts|cts)$/.test(n) ? [p] : [];
  });
}

for (const root of roots) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const text = walk(root)
    .filter((f) => !f.endsWith('package.json'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const scripts = JSON.stringify(pkg.scripts ?? {});
  const unused = Object.keys(declared).filter((name) => {
    const bare = name.replace(/^@types\//, '');
    return !(
      text.includes(`'${name}`) ||
      text.includes(`"${name}`) ||
      text.includes(`'${bare}`) ||
      scripts.includes(name.split('/').pop())
    );
  });
  process.stdout.write(`${root}: ${unused.length ? unused.join(', ') : 'none'}\n`);
}
