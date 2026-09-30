import { notify } from '../../lib/notifications';
import { query } from '../../lib/db';

/**
 * The people who handle safety: active admins holding SAFETY_REVIEW. They are told through the one
 * notification system. A notification here carries no names, no locations and no descriptions — it says
 * that something needs attention and where to look; the details are behind the permission and the audit.
 */
export async function notifySafetyTeam(input: {
  type: string;
  body: string;
  metadata: Record<string, unknown>;
}): Promise<number> {
  const admins = await query<{ id: string }>(
    `SELECT id FROM users
     WHERE role = 'ADMIN' AND status = 'ACTIVE' AND 'SAFETY_REVIEW' = ANY(admin_permissions)`,
  );
  await Promise.all(
    admins.rows.map((a) =>
      notify({
        userId: a.id,
        type: input.type,
        title: 'Yatri safety',
        body: input.body,
        metadata: input.metadata,
      }).catch(() => undefined),
    ),
  );
  return admins.rows.length;
}
