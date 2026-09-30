import type { AdminPermission, SupportNotificationType } from '@yatri/types';

import { query } from '../../lib/db';
import { notify } from '../../lib/notifications';

/**
 * How support talks to people, through the one notification system. Words for a person about their own
 * request are built by the shared describe functions; a message to the support team says only that
 * something needs attention and where to look (no names, no message text).
 */
export async function notifyRequester(
  userId: string,
  type: SupportNotificationType,
  body: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await notify({ userId, type, title: 'Yatri support', body, metadata }).catch(() => undefined);
}

/** Active admins who hold a permission (the team that handles this kind of work). */
export async function adminsHolding(permission: AdminPermission): Promise<string[]> {
  const r = await query<{ id: string }>(
    `SELECT id FROM users
     WHERE role = 'ADMIN' AND status = 'ACTIVE' AND $1 = ANY(admin_permissions)`,
    [permission],
  );
  return r.rows.map((a) => a.id);
}

/** Tell the assigned admin, or the whole support team when nobody has picked the ticket up. */
export async function notifySupportTeam(input: {
  type: SupportNotificationType;
  body: string;
  ticketId: string;
  assignedTo?: string | null;
}): Promise<void> {
  // SUPPORT_MANAGE also covers disputes (it implies DISPUTES_MANAGE); DISPUTES_MANAGE alone is a subset.
  const ids = input.assignedTo
    ? [input.assignedTo]
    : [
        ...new Set([
          ...(await adminsHolding('SUPPORT_MANAGE')),
          ...(await adminsHolding('DISPUTES_MANAGE')),
        ]),
      ];
  await Promise.all(
    ids.map((userId) =>
      notify({
        userId,
        type: input.type,
        title: 'Yatri support',
        body: input.body,
        metadata: { ticketId: input.ticketId },
      }).catch(() => undefined),
    ),
  );
}
