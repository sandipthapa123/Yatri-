import type { AuditEntry } from '@yatri/types';

import { query } from './db';

/**
 * THE audit log: who did or looked at what, when. One table for sensitive reads (an admin viewed a
 * driver's location or a chat) and for actions on safety records (an SOS raised, acknowledged or
 * resolved; an incident reported, moved, annotated). Nothing here stores a secret or a message body;
 * `detail` holds only the small facts needed to understand the entry (a status change, a count).
 */
export interface AuditInput {
  /** Null for the system acting on its own. */
  actorId: string | null;
  actorRole: 'ADMIN' | 'PASSENGER' | 'DRIVER' | 'SYSTEM';
  action: string;
  subjectType: string;
  subjectIds: string[];
  detail?: Record<string, unknown>;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  if (input.subjectIds.length === 0) return;
  await query(
    `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, subject_id, detail)
     SELECT $1, $2, $3, $4, s, $6::jsonb FROM unnest($5::uuid[]) AS s`,
    [
      input.actorId,
      input.actorRole,
      input.action,
      input.subjectType,
      input.subjectIds,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

/** The trail for one record, oldest first (for the admin pages). */
export async function auditTrail(subjectType: string, subjectId: string): Promise<AuditEntry[]> {
  const r = await query<{
    id: string;
    action: string;
    actor_role: string | null;
    detail: Record<string, unknown>;
    created_at: Date;
    full_name: string | null;
  }>(
    `SELECT a.id::text, a.action, a.actor_role, a.detail, a.created_at, u.full_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.subject_type = $1 AND a.subject_id = $2 ORDER BY a.id`,
    [subjectType, subjectId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorName: row.full_name,
    actorRole: row.actor_role,
    detail: row.detail,
    createdAt: row.created_at.toISOString(),
  }));
}
