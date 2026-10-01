import { ADMIN_PERMISSIONS, holdsPermission, type AdminPermission } from '@yatri/types';
import type { RequestHandler } from 'express';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { log } from '../../lib/logger';

/**
 * Admin permissions and the audit of sensitive reads: defined here once, used by every admin
 * feature. (The permission names live in ADMIN_PERMISSIONS in @yatri/types.)
 */
export async function adminPermissions(adminId: string): Promise<AdminPermission[]> {
  const r = await query<{ admin_permissions: string[] }>(
    "SELECT admin_permissions FROM users WHERE id = $1 AND role = 'ADMIN' AND status = 'ACTIVE'",
    [adminId],
  );
  // Only names this build knows: a stale value in the database grants nothing.
  return (r.rows[0]?.admin_permissions ?? []).filter((p): p is AdminPermission =>
    (ADMIN_PERMISSIONS as readonly string[]).includes(p),
  );
}

/** Whether this admin holds a permission (a MANAGE permission counts as its VIEW). Read fresh every time. */
export async function hasPermission(
  adminId: string,
  permission: AdminPermission,
): Promise<boolean> {
  return holdsPermission(await adminPermissions(adminId), permission);
}

/**
 * The ONE way an admin route is protected: put this in front of it. Holding the ADMIN role opens
 * nothing by itself; each route names the single permission it needs, and permissions are read from
 * the database on every request so a removed permission takes effect immediately.
 */
export function requirePermission(permission: AdminPermission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.'));
    hasPermission(req.auth.userId, permission).then((ok) => {
      if (ok) return next();
      next(new HttpError(403, 'FORBIDDEN', 'Your account does not have access to this.'));
    }, next);
  };
}

/** Record that an admin read sensitive data about one or more subjects (the one audit log). */
export async function recordAdminAccess(
  adminId: string,
  action:
    | 'VIEW_DRIVER_LOCATION'
    | 'VIEW_TRIP_CHAT'
    | 'VIEW_TRIP_DRIVER_LOCATION'
    | 'VIEW_TRIP_ACCESSIBILITY',
  subjectType: 'driver' | 'trip',
  subjectIds: string[],
): Promise<void> {
  await recordAudit({ actorId: adminId, actorRole: 'ADMIN', action, subjectType, subjectIds });
}

/**
 * Audit an admin's action at the route, the same way for every action: when the handler answers
 * successfully, one entry is written (who, what, which record, and the admin's stated reason if the
 * request carried one) BEFORE the answer leaves, so a reply always means the audit exists. Handlers
 * stay free of audit code; a route that changes something sensitive names its action here.
 */
export function auditAdminAction(
  action: string,
  subjectType: string,
  subject: 'param' | 'none' = 'param',
): RequestHandler {
  return (req, res, next) => {
    const send = res.json.bind(res);
    res.json = ((body: unknown) => {
      const actor = req.auth?.userId;
      if (!actor || res.statusCode >= 400) return send(body);
      const raw = req.params.id;
      const id = Array.isArray(raw) ? raw[0] : raw;
      const reason = (req.body as { reason?: unknown } | undefined)?.reason;
      recordAudit({
        actorId: actor,
        actorRole: 'ADMIN',
        action,
        subjectType,
        subjectIds: subject === 'param' && id ? [id] : null,
        detail: typeof reason === 'string' ? { reason } : {},
      })
        .catch((err) => log.error('audit write failed', action, err))
        .finally(() => send(body));
      return res;
    }) as typeof res.json;
    next();
  };
}
