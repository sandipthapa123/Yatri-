// Lists source files that no other file imports. A first-pass search for dead code, not a verdict:
// entry points, route files loaded by the framework (Next pages, layouts), and migrations are expected
// and are skipped. Run from the repository root:  node scripts/dead-files.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const roots = [
  'apps/api/src',
  'apps/admin/src',
  'apps/passenger/src',
  'apps/driver/src',
  'packages/types/src',
  'packages/shared/src',
  'packages/mobile-auth/src',
  'packages/mobile-location/src',
  'packages/mobile-ride/src',
  'packages/mobile-support/src',
  'packages/mobile-ui/src',
];
const SKIP = new Set(['node_modules', 'dist', '.next']);
const ENTRY =
  /(^|[\\/])(index|App|proxy|layout|page|loading|error|not-found|route|next-env\.d|express\.d)\.(tsx?|d\.ts)$/;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (SKIP.has(n)) return [];
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?)$/.test(n) ? [p] : [];
  });
}

const all = roots.flatMap(walk);
const text = new Map(all.map((f) => [f, readFileSync(f, 'utf8')]));
const dead = [];
for (const f of all) {
  if (/\.test\.tsx?$/.test(f) || ENTRY.test(f) || /[\\/]test[\\/]/.test(f)) continue;
  const stem = basename(f).replace(/\.(tsx?)$/, '');
  const used = [...text.entries()].some(
    ([g, t]) =>
      g !== f &&
      new RegExp(
        `from ['"][^'"]*[\\\\/]${stem}['"]|from ['"]\\./${stem}['"]|import\\(['"][^'"]*${stem}['"]\\)`,
      ).test(t),
  );
  if (!used) dead.push(f);
}
process.stdout.write(`${dead.length ? dead.join('\n') : 'none'}\n`);
