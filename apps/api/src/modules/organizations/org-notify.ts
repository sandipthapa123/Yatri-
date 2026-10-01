import type { OrgNotificationType } from '@yatri/types';

import { query } from '../../lib/db';
import { notify } from '../../lib/notifications';

/**
 * How organizations talk to people, through the one notification system. A message names the organization
 * and what happened; it never carries a fare breakdown, a location or a phone number.
 */
export async function notifyPerson(
  userId: string,
  type: OrgNotificationType,
  body: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await notify({ userId, type, title: 'Yatri business', body, metadata }).catch(() => undefined);
}

/** Active members who hold the given role(s). */
export async function membersWithRoles(orgId: string, roles: readonly string[]): Promise<string[]> {
  const r = await query<{ user_id: string }>(
    `SELECT user_id FROM organization_members
     WHERE organization_id = $1 AND status = 'ACTIVE' AND role = ANY($2::text[])`,
    [orgId, [...roles]],
  );
  return r.rows.map((m) => m.user_id);
}
