import {
  ADMIN_PERMISSIONS,
  type AdminAccountRow,
  type AdminMe,
  type AdminPermission,
  type ApiResponse,
  type SetPermissionsBody,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import { findUserById } from '../users/users.repository';
import { adminPermissions } from './permissions';

export const setPermissionsSchema = z
  .object({
    permissions: z.array(z.enum(ADMIN_PERMISSIONS)).max(ADMIN_PERMISSIONS.length),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

/** Who is signed in, and what they may do: the admin app shows only what the API would allow. */
export async function adminMeHandler(req: Request, res: Response<ApiResponse<AdminMe>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const user = await findUserById(req.auth.userId);
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  res.json({
    success: true,
    data: {
      id: user.id,
      role: user.role,
      status: user.status,
      fullName: user.full_name,
      phoneNumber: user.phone_number,
      profilePictureUrl: user.profile_picture_url,
      createdAt: user.created_at.toISOString(),
      permissions: await adminPermissions(user.id),
    },
  });
}

export async function listAdminsHandler(
  req: Request,
  res: Response<ApiResponse<AdminAccountRow[]>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const r = await query<{
    id: string;
    full_name: string | null;
    email: string | null;
    status: AdminAccountRow['status'];
    admin_permissions: string[];
    created_at: Date;
  }>(
    `SELECT id, full_name, email, status, admin_permissions, created_at
     FROM users WHERE role = 'ADMIN' ORDER BY created_at, id`,
  );
  res.json({
    success: true,
    data: r.rows.map((a) => ({
      id: a.id,
      fullName: a.full_name,
      email: a.email,
      status: a.status,
      permissions: a.admin_permissions.filter((p): p is AdminPermission =>
        (ADMIN_PERMISSIONS as readonly string[]).includes(p),
      ),
      createdAt: a.created_at.toISOString(),
      isYou: a.id === req.auth?.userId,
    })),
  });
}

/**
 * Replace another administrator's permissions. Rules, all enforced here:
 *  - you cannot change your own (nobody can grant themselves more, or lock themselves out);
 *  - you can only grant a permission you hold yourself;
 *  - the change is made under a row lock, so two managers editing one admin apply one after the other;
 *  - what was removed and granted, and why, is written to the audit log.
 */
export async function setPermissionsHandler(
  req: Request,
  res: Response<ApiResponse<AdminAccountRow>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const targetId = requireParam(req, 'id');
  const body = req.body as SetPermissionsBody;
  if (targetId === req.auth.userId) {
    throw new HttpError(409, 'CANNOT_CHANGE_SELF', 'You cannot change your own permissions.');
  }
  const wanted = [...new Set(body.permissions)].sort();
  const mine = await adminPermissions(req.auth.userId);
  const notHeld = wanted.filter((p) => !mine.includes(p));

  let before: AdminPermission[] = [];
  await withTransaction(async (client) => {
    const cur = await client.query<{ admin_permissions: string[] }>(
      "SELECT admin_permissions FROM users WHERE id = $1 AND role = 'ADMIN' FOR UPDATE",
      [targetId],
    );
    if (!cur.rows[0]) {
      throw new HttpError(404, 'NOT_FOUND', 'Administrator not found.');
    }
    before = cur.rows[0].admin_permissions.filter((p): p is AdminPermission =>
      (ADMIN_PERMISSIONS as readonly string[]).includes(p),
    );
    // Granting is limited to what you hold; taking away is not (you may remove anything).
    const granting = wanted.filter((p) => !before.includes(p));
    const overreach = granting.filter((p) => notHeld.includes(p));
    if (overreach.length > 0) {
      throw new HttpError(
        403,
        'CANNOT_GRANT',
        'You can only grant permissions you hold yourself.',
      ).withDetails({ permissions: overreach });
    }
    await client.query(
      'UPDATE users SET admin_permissions = $2::text[], updated_at = now() WHERE id = $1',
      [targetId, wanted],
    );
  });

  await recordAudit({
    actorId: req.auth.userId,
    actorRole: 'ADMIN',
    action: 'ADMIN_PERMISSIONS_CHANGED',
    subjectType: 'admin',
    subjectIds: [targetId],
    detail: {
      granted: wanted.filter((p) => !before.includes(p as AdminPermission)),
      removed: before.filter((p) => !wanted.includes(p)),
      reason: body.reason,
    },
  });
  const user = await findUserById(targetId);
  res.json({
    success: true,
    data: {
      id: targetId,
      fullName: user?.full_name ?? null,
      email: user?.email ?? null,
      status: user?.status ?? 'ACTIVE',
      permissions: wanted as AdminPermission[],
      createdAt: user?.created_at.toISOString() ?? new Date().toISOString(),
      isYou: false,
    },
  });
}
