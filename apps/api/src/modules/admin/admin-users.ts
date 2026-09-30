import {
  ACCOUNT_ADMIN_MOVES,
  ADMIN_SORTS,
  ACTIVE_TRIP_STATUSES,
  type AccountStatus,
  type AdminListResponse,
  type AdminUserDetail,
  type AdminUserRow,
  type ApiResponse,
  type DriverStatus,
  type TripStatus,
  type UserRole,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAudit, auditTrail } from '../../lib/audit';
import { query } from '../../lib/db';
import { requireParam } from '../../lib/params';
import { sqlIn } from '../../lib/sql';
import { HttpError } from '../../middleware/errorHandler';
import { revokeAllUserSessions } from '../auth/session.repository';
import { forceSuspend } from '../availability/availability.service';
import { ratingSummary } from '../trips/ratings.service';
import { likeContains } from './admin-range';
import { hasPermission } from './permissions';

export const adminUsersQuerySchema = z.object({
  role: z.enum(['PASSENGER', 'DRIVER', 'ADMIN']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(ADMIN_SORTS as [string, ...string[]]).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const userStatusChangeSchema = z
  .object({ reason: z.string().trim().min(3).max(300) })
  .strict();

const ORDER: Record<string, string> = {
  newest: 'u.created_at DESC, u.id',
  oldest: 'u.created_at ASC, u.id',
  name: 'lower(u.full_name) ASC NULLS LAST, u.id',
};

interface UserRowDb {
  id: string;
  role: UserRole;
  status: AccountStatus;
  full_name: string | null;
  phone_number: string | null;
  email: string | null;
  created_at: Date;
  completed: number;
}

const toRow = (r: UserRowDb): AdminUserRow => ({
  id: r.id,
  role: r.role,
  status: r.status,
  fullName: r.full_name,
  phoneNumber: r.phone_number,
  email: r.email,
  createdAt: r.created_at.toISOString(),
  ridesCompleted: r.completed,
});

const COMPLETED_SQL = `(SELECT count(*)::int FROM trips t
   WHERE t.status = 'COMPLETED' AND (t.passenger_id = u.id OR t.driver_id = u.id))`;

export async function listUsersHandler(
  req: Request,
  res: Response<ApiResponse<AdminListResponse<AdminUserRow>>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const q = req.validatedQuery as z.infer<typeof adminUsersQuerySchema>;
  const params = [q.role ?? null, q.status ?? null, q.search ? likeContains(q.search) : null];
  const where = `WHERE ($1::text IS NULL OR u.role::text = $1)
      AND ($2::text IS NULL OR u.status::text = $2)
      AND ($3::text IS NULL OR u.full_name ILIKE $3 ESCAPE '!' OR u.phone_number ILIKE $3 ESCAPE '!'
           OR u.email ILIKE $3 ESCAPE '!')`;
  const [rows, count] = await Promise.all([
    query<UserRowDb>(
      `SELECT u.id, u.role, u.status, u.full_name, u.phone_number, u.email, u.created_at,
              ${COMPLETED_SQL} AS completed
       FROM users u ${where} ORDER BY ${ORDER[q.sort] ?? ORDER.newest}
       LIMIT $4 OFFSET $5`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM users u ${where}`, params),
  ]);
  // Names, numbers and addresses were shown: that is one audited read (not one row per person).
  await recordAudit({
    actorId: req.auth.userId,
    actorRole: 'ADMIN',
    action: 'VIEW_USER_LIST',
    subjectType: 'user',
    subjectIds: null,
    detail: { shown: rows.rows.length, searched: !!q.search },
  });
  res.json({
    success: true,
    data: {
      items: rows.rows.map(toRow),
      total: count.rows[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    },
  });
}

async function loadUser(id: string): Promise<UserRowDb> {
  const r = await query<UserRowDb>(
    `SELECT u.id, u.role, u.status, u.full_name, u.phone_number, u.email, u.created_at,
            ${COMPLETED_SQL} AS completed
     FROM users u WHERE u.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  return row;
}

export async function userDetailHandler(req: Request, res: Response<ApiResponse<AdminUserDetail>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const id = requireParam(req, 'id');
  const user = await loadUser(id);
  await recordAudit({
    actorId: req.auth.userId,
    actorRole: 'ADMIN',
    action: 'VIEW_USER',
    subjectType: 'user',
    subjectIds: [id],
  });
  const [counts, active, driver, rating, canManage, canManageAdmins] = await Promise.all([
    query<{ requested: number; cancelled: number }>(
      `SELECT count(*)::int AS requested,
              count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
       FROM trips WHERE passenger_id = $1 OR driver_id = $1`,
      [id],
    ),
    query<{ id: string; status: TripStatus }>(
      `SELECT id, status FROM trips
       WHERE (passenger_id = $1 OR driver_id = $1)
         AND status IN ${sqlIn(ACTIVE_TRIP_STATUSES)}
       LIMIT 1`,
      [id],
    ),
    query<{ status: DriverStatus }>('SELECT status FROM driver_profiles WHERE user_id = $1', [id]),
    ratingSummary(id),
    hasPermission(req.auth.userId, 'USERS_MANAGE'),
    hasPermission(req.auth.userId, 'ADMINS_MANAGE'),
  ]);
  const mayTouch =
    canManage && id !== req.auth.userId && (user.role !== 'ADMIN' || canManageAdmins);
  const c = counts.rows[0] ?? { requested: 0, cancelled: 0 };
  res.json({
    success: true,
    data: {
      ...toRow(user),
      driverStatus: driver.rows[0]?.status ?? null,
      ridesRequested: c.requested,
      ridesCancelled: c.cancelled,
      rating,
      activeRide: active.rows[0]
        ? { tripId: active.rows[0].id, status: active.rows[0].status }
        : null,
      canSuspend: mayTouch && ACCOUNT_ADMIN_MOVES[user.status] === 'SUSPENDED',
      canReactivate: mayTouch && ACCOUNT_ADMIN_MOVES[user.status] === 'ACTIVE',
      audit: await auditTrail('user', id),
    },
  });
}

/**
 * Suspend or reactivate an account. The legal moves come from ACCOUNT_ADMIN_MOVES (@yatri/types);
 * the update is guarded on the status the move starts from, so two admins clicking at once cannot
 * both apply. Suspending signs the person out of every device, takes a driver off the road, and is
 * refused while they are on a ride (cancel or finish that first). Everything is audited.
 */
function changeStatus(to: 'SUSPENDED' | 'ACTIVE') {
  const from: AccountStatus = to === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
  return async (req: Request, res: Response<ApiResponse<{ status: AccountStatus }>>) => {
    if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
    const id = requireParam(req, 'id');
    const { reason } = req.body as z.infer<typeof userStatusChangeSchema>;
    if (id === req.auth.userId) {
      throw new HttpError(409, 'CANNOT_CHANGE_SELF', 'You cannot change your own account status.');
    }
    const user = await loadUser(id);
    if (user.role === 'ADMIN' && !(await hasPermission(req.auth.userId, 'ADMINS_MANAGE'))) {
      throw new HttpError(
        403,
        'FORBIDDEN',
        'Only an administrator manager can change an administrator.',
      );
    }
    if (ACCOUNT_ADMIN_MOVES[from] !== to) {
      throw new HttpError(409, 'INVALID_STATE_TRANSITION', 'That change is not possible.');
    }
    if (to === 'SUSPENDED') {
      const busy = await query(
        `SELECT 1 FROM trips WHERE (passenger_id = $1 OR driver_id = $1)
           AND status IN ${sqlIn(ACTIVE_TRIP_STATUSES)} LIMIT 1`,
        [id],
      );
      if (busy.rowCount) {
        throw new HttpError(
          409,
          'USER_HAS_ACTIVE_RIDE',
          'This person is on a ride. Cancel or finish the ride first.',
        );
      }
    }
    const moved = await query(
      'UPDATE users SET status = $2, updated_at = now() WHERE id = $1 AND status = $3 RETURNING id',
      [id, to, from],
    );
    if (!moved.rowCount) {
      throw new HttpError(
        409,
        'INVALID_STATE_TRANSITION',
        user.status === to
          ? `This account is already ${to === 'SUSPENDED' ? 'suspended' : 'active'}.`
          : 'This account cannot be changed (it may have been deactivated by its owner).',
      );
    }
    if (to === 'SUSPENDED') {
      await revokeAllUserSessions(id);
      if (user.role === 'DRIVER') await forceSuspend(id, req.auth.userId);
    }
    await recordAudit({
      actorId: req.auth.userId,
      actorRole: 'ADMIN',
      action: to === 'SUSPENDED' ? 'USER_SUSPENDED' : 'USER_REACTIVATED',
      subjectType: 'user',
      subjectIds: [id],
      detail: { reason, role: user.role },
    });
    res.json({ success: true, data: { status: to } });
  };
}
export const suspendUserHandler = changeStatus('SUSPENDED');
export const reactivateUserHandler = changeStatus('ACTIVE');
