import type { AdminPermission } from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';

/**
 * Admin permissions and the audit of sensitive reads: defined here once, used by every admin
 * feature. (The permission names live in ADMIN_PERMISSIONS in @yatri/types.)
 */
export async function hasPermission(
  adminId: string,
  permission: AdminPermission,
): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    "SELECT $2 = ANY(admin_permissions) AS ok FROM users WHERE id = $1 AND role = 'ADMIN'",
    [adminId, permission],
  );
  return r.rows[0]?.ok === true;
}

/** Record that an admin read sensitive data about one or more subjects (the one audit log). */
export async function recordAdminAccess(
  adminId: string,
  action: 'VIEW_DRIVER_LOCATION' | 'VIEW_TRIP_CHAT' | 'VIEW_TRIP_DRIVER_LOCATION',
  subjectType: 'driver' | 'trip',
  subjectIds: string[],
): Promise<void> {
  await recordAudit({ actorId: adminId, actorRole: 'ADMIN', action, subjectType, subjectIds });
}
