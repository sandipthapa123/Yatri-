import { pageParam, pageSizeParam } from '../../lib/pagination';
import type {
  AdminListResponse,
  AdminNotificationRow,
  ApiResponse,
  NotificationSummary,
  UserRole,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { query } from '../../lib/db';
import { likeContains, rangeFields, resolveRange, type RangeQuery } from './admin-range';

/**
 * Notification monitoring: what was sent, of which type, to whom (by name), when, and whether it was
 * read. The words themselves are never shown here — they can contain a place, a name or a fare —
 * so operations can see that the system is talking without reading anyone's messages.
 */
export const adminNotificationsQuerySchema = z.object({
  ...rangeFields,
  type: z.string().trim().max(60).optional(),
  read: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(100).optional(),
  page: pageParam,
  pageSize: pageSizeParam(50, 20),
});
export const adminNotificationSummarySchema = z.object(rangeFields);

export async function notificationSummaryHandler(
  req: Request,
  res: Response<ApiResponse<NotificationSummary>>,
) {
  const range = await resolveRange(req.validatedQuery as RangeQuery, '7d');
  const r = await query<{ type: string; n: number; read: number }>(
    `SELECT type, count(*)::int AS n, count(read_at)::int AS read
     FROM notifications WHERE created_at >= $1 AND created_at < $2
     GROUP BY type ORDER BY n DESC, type`,
    [range.from, range.to],
  );
  const total = r.rows.reduce((s, x) => s + x.n, 0);
  const read = r.rows.reduce((s, x) => s + x.read, 0);
  res.json({
    success: true,
    data: {
      range,
      total,
      read,
      unread: total - read,
      byType: r.rows.map((x) => ({ type: x.type, count: x.n })),
    },
  });
}

export async function listNotificationsHandler(
  req: Request,
  res: Response<ApiResponse<AdminListResponse<AdminNotificationRow>>>,
) {
  const q = req.validatedQuery as z.infer<typeof adminNotificationsQuerySchema>;
  const range = await resolveRange(q, '7d');
  const params = [
    range.from,
    range.to,
    q.type ?? null,
    q.read === undefined ? null : q.read === 'true',
    q.search ? likeContains(q.search) : null,
  ];
  const from = `
    FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE n.created_at >= $1 AND n.created_at < $2
      AND ($3::text IS NULL OR n.type = $3)
      AND ($4::boolean IS NULL OR (n.read_at IS NOT NULL) = $4)
      AND ($5::text IS NULL OR u.full_name ILIKE $5 ESCAPE '!' OR n.type ILIKE $5 ESCAPE '!')`;
  const [rows, count] = await Promise.all([
    query<{
      id: string;
      type: string;
      title: string;
      name: string | null;
      role: UserRole;
      created_at: Date;
      read_at: Date | null;
    }>(
      `SELECT n.id, n.type, n.title, u.full_name AS name, u.role, n.created_at, n.read_at
       ${from} ORDER BY n.created_at DESC, n.id LIMIT $6 OFFSET $7`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n ${from}`, params),
  ]);
  res.json({
    success: true,
    data: {
      items: rows.rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        userName: r.name,
        userRole: r.role,
        createdAt: r.created_at.toISOString(),
        read: r.read_at !== null,
      })),
      total: count.rows[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    },
  });
}
