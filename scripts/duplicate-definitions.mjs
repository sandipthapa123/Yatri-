// Finds names that are DEFINED (exported const, function, type or interface) in more than one source file,
// and status-like string lists written out in more than one file outside the shared package. A first-pass
// single-source-of-truth check, not a verdict: two different things may legitimately share a name.
// Run from the repository root:  node scripts/duplicate-definitions.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

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
  'packages/mobile-ui/src',
];
const SKIP = new Set(['node_modules', 'dist', '.next', 'test']);

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (SKIP.has(n)) return [];
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

const files = roots.flatMap(walk);
const defs = new Map();
const definition =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|function|interface|type|class)\s+([A-Za-z_$][\w$]*)/gm;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(definition)) {
    const list = defs.get(m[1]) ?? [];
    if (!list.includes(f)) list.push(f);
    defs.set(m[1], list);
  }
}
const repeated = [...defs].filter(([, list]) => list.length > 1);
// names that are deliberately per-app (each app has its own screen or navigator with this name)
const PER_APP = new Set([
  'RootNavigator',
  'RootStackParamList',
  'useTheme',
  'ErrorScreen',
  'LoadingScreen',
  'OtpVerificationScreen',
  'PhoneEntryScreen',
  'WelcomeScreen',
  'ProfileSetupScreen',
  'styles',
  'default',
]);
const real = repeated.filter(([name]) => !PER_APP.has(name));
process.stdout.write(`${real.length} name(s) defined in more than one file\n`);
for (const [name, list] of real)
  process.stdout.write(`  ${name}: ${list.map((f) => relative('.', f)).join(', ')}\n`);

// The trip-status words, listed out by hand somewhere other than the shared package.
const STATUS_LIST = /'SEARCHING'[\s\S]{0,40}'DRIVER_EN_ROUTE'/;
const stray = files.filter(
  (f) =>
    !f.includes('packages/types') &&
    !f.includes('packages\\types') &&
    STATUS_LIST.test(readFileSync(f, 'utf8')),
);
process.stdout.write(`${stray.length} file(s) list trip statuses by hand outside @yatri/types\n`);
for (const f of stray) process.stdout.write(`  ${relative('.', f)}\n`);
