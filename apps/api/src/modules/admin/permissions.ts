import type { AdminPermission } from '@yatri/types';

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

/** Record that an admin read sensitive data about one or more subjects. */
export async function recordAdminAccess(
  adminId: string,
  action: 'VIEW_DRIVER_LOCATION' | 'VIEW_TRIP_CHAT' | 'VIEW_TRIP_DRIVER_LOCATION',
  subjectType: 'driver' | 'trip',
  subjectIds: string[],
): Promise<void> {
  if (subjectIds.length === 0) return;
  await query(
    `INSERT INTO admin_access_log (admin_id, action, subject_type, subject_id)
     SELECT $1, $2, $3, s FROM unnest($4::uuid[]) AS s`,
    [adminId, action, subjectType, subjectIds],
  );
}
