import type { AdminAuditRow, AdminListResponse, ApiResponse } from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { likeContains, rangeFields, resolveRange } from './admin-range';

/** Read the one audit log. Reading it is itself recorded, so the trail cannot be browsed unseen. */
export const adminAuditQuerySchema = z.object({
  ...rangeFields,
  action: z.string().trim().max(60).optional(),
  subjectType: z.string().trim().max(40).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(30),
});

export async function listAuditHandler(
  req: Request,
  res: Response<ApiResponse<AdminListResponse<AdminAuditRow>>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const q = req.validatedQuery as z.infer<typeof adminAuditQuerySchema>;
  const range = await resolveRange(q, '7d');
  const params = [
    range.from,
    range.to,
    q.action ?? null,
    q.subjectType ?? null,
    q.search ? likeContains(q.search) : null,
  ];
  const from = `
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.created_at >= $1 AND a.created_at < $2
      AND ($3::text IS NULL OR a.action = $3)
      AND ($4::text IS NULL OR a.subject_type = $4)
      AND ($5::text IS NULL OR u.full_name ILIKE $5 ESCAPE '!' OR a.action ILIKE $5 ESCAPE '!')`;
  const [rows, count] = await Promise.all([
    query<{
      id: string;
      action: string;
      actor_role: string | null;
      detail: Record<string, unknown>;
      created_at: Date;
      subject_type: string;
      subject_id: string | null;
      name: string | null;
    }>(
      `SELECT a.id::text, a.action, a.actor_role, a.detail, a.created_at, a.subject_type,
              a.subject_id, u.full_name AS name
       ${from} ORDER BY a.id DESC LIMIT $6 OFFSET $7`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n ${from}`, params),
  ]);
  await recordAudit({
    actorId: req.auth.userId,
    actorRole: 'ADMIN',
    action: 'VIEW_AUDIT_LOG',
    subjectType: 'audit',
    subjectIds: null,
    detail: { range: range.label, action: q.action ?? null },
  });
  res.json({
    success: true,
    data: {
      items: rows.rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorName: r.name,
        actorRole: r.actor_role,
        detail: r.detail,
        createdAt: r.created_at.toISOString(),
        subjectType: r.subject_type,
        subjectIds: r.subject_id ? [r.subject_id] : [],
      })),
      total: count.rows[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    },
  });
}
