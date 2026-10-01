import { orgRoleHolds, type OrgPermission, type OrgRole, type OrgStatus } from '@yatri/types';
import type { PoolClient } from 'pg';
import type { Request, RequestHandler, Response } from 'express';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';

/**
 * Organization authorization, separate from platform roles. A person acts for an organization only through an
 * ACTIVE membership, and what they may do is the role's row in ORG_ROLE_PERMISSIONS (@yatri/types). It is read
 * from the database on every request, so removing someone or changing their role takes effect at once. A person
 * who is not a member gets the same 404 as an organization that does not exist: the existence of someone
 * else's organization is not revealed.
 */
export interface OrgContext {
  orgId: string;
  userId: string;
  role: OrgRole;
  orgStatus: OrgStatus;
}

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Organization not found.');

export async function loadContext(
  orgId: string,
  userId: string,
  client?: PoolClient,
): Promise<OrgContext | null> {
  const sql = `SELECT m.role, o.status FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE'`;
  const r = client
    ? await client.query<{ role: OrgRole; status: OrgStatus }>(sql, [orgId, userId])
    : await query<{ role: OrgRole; status: OrgStatus }>(sql, [orgId, userId]);
  const row = r.rows[0];
  return row ? { orgId, userId, role: row.role, orgStatus: row.status } : null;
}

/**
 * Put in front of an organization route. `permission` null means any active member; otherwise the role must
 * hold it. A member lacking it is told so (403); a stranger is told the organization does not exist (404).
 */
export function requireOrgPermission(permission: OrgPermission | null): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.'));
    const orgId = req.params.orgId;
    if (typeof orgId !== 'string') return next(notFound());
    loadContext(orgId, req.auth.userId)
      .then((ctx) => {
        if (!ctx) return next(notFound());
        if (permission && !orgRoleHolds(ctx.role, permission)) {
          return next(
            new HttpError(403, 'FORBIDDEN', 'Your role in this organization does not allow this.'),
          );
        }
        res.locals.org = ctx;
        next();
      })
      .catch(next);
  };
}

export const orgContext = (res: Response): OrgContext => res.locals.org as OrgContext;
export const callerId = (req: Request): string => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};

/** A suspended organization keeps its records but cannot start anything new. */
export function assertOrgActive(ctx: Pick<OrgContext, 'orgStatus'>): void {
  if (ctx.orgStatus !== 'ACTIVE') {
    throw new HttpError(
      409,
      'ORGANIZATION_SUSPENDED',
      'This organization is suspended. Please contact Yatri support.',
    );
  }
}

/** Platform administrators and drivers are not organization users: the business features belong to rider accounts. */
export function assertRider(req: Request): void {
  if (req.auth?.role !== 'PASSENGER') {
    throw new HttpError(403, 'FORBIDDEN', 'Business accounts are for rider accounts.');
  }
}
