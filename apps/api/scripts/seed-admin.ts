/**
 * Creates a single development admin account from ADMIN_SEED_EMAIL /
 * ADMIN_SEED_PASSWORD. DEVELOPMENT ONLY: refuses to run when
 * NODE_ENV=production, and does nothing unless both env vars are set — the
 * codebase ships no default admin credentials of any kind. In a real
 * environment, create admin accounts out-of-band (direct DB insert by an
 * operator, or a future admin-invite flow), not with this script.
 */
import { ADMIN_PERMISSIONS } from '@yatri/types';

import { env, isProduction } from '../src/config/env';
import { hashSecret, PASSWORD_HASH_ROUNDS } from '../src/lib/password';
import { createAdmin, findUserByEmail } from '../src/modules/users/users.repository';
import { pool } from '../src/config/database';

async function grantPermissions(adminId: string) {
  if (env.ADMIN_SEED_PERMISSIONS.length === 0) return;
  // ALL means every permission that exists (development convenience); names are checked against the one list.
  const wanted = env.ADMIN_SEED_PERMISSIONS.includes('ALL')
    ? [...ADMIN_PERMISSIONS]
    : env.ADMIN_SEED_PERMISSIONS;
  const unknown = wanted.filter((p) => !(ADMIN_PERMISSIONS as readonly string[]).includes(p));
  if (unknown.length > 0) {
    console.error(`Unknown permission(s) in ADMIN_SEED_PERMISSIONS: ${unknown.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  await pool.query('UPDATE users SET admin_permissions = $2::text[] WHERE id = $1', [
    adminId,
    wanted,
  ]);
  console.log(`Granted permissions: ${wanted.join(', ')}`);
}

async function main() {
  if (isProduction) {
    console.error('Refusing to run: NODE_ENV=production. Seed scripts are development-only.');
    process.exitCode = 1;
    return;
  }

  if (!env.ADMIN_SEED_EMAIL || !env.ADMIN_SEED_PASSWORD) {
    console.error(
      'ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD must both be set (see apps/api/.env.example).',
    );
    process.exitCode = 1;
    return;
  }

  const existing = await findUserByEmail(env.ADMIN_SEED_EMAIL);
  if (existing) {
    await grantPermissions(existing.id);
    console.log(`Admin account already exists for ${env.ADMIN_SEED_EMAIL}; nothing to do.`);
    return;
  }

  const passwordHash = await hashSecret(env.ADMIN_SEED_PASSWORD, PASSWORD_HASH_ROUNDS);
  const admin = await createAdmin(env.ADMIN_SEED_EMAIL, passwordHash, 'Development Admin');
  await grantPermissions(admin.id);
  console.log(`Created development admin account: ${admin.email} (id ${admin.id})`);
}

main()
  .catch((err) => {
    console.error('Failed to seed admin account:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
