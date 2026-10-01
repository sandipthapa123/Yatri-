import {
  ORG_NOTIFICATION_TYPES,
  ORG_STATUS_MOVES,
  type AdminOrganizationDetail,
  type AdminOrganizationRow,
  type OrgStatus,
} from '@yatri/types';

import { auditTrail, recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { likeContains } from '../admin/admin-range';
import { membersWithRoles, notifyPerson } from './org-notify';
import { getPolicy } from './policy.service';
import { listStatements } from './statements.service';
import { ORG_TRIP_COST_SQL } from './spend';

/**
 * What the PLATFORM sees and may do about an organization (ORGANIZATIONS_VIEW / ORGANIZATIONS_MANAGE, separate
 * from any organization role): look at it, suspend or reactivate it with a reason. The platform never edits an
 * organization's members, policy or rides: those belong to the organization's own roles. Suspending stops new
 * bookings and approvals and withdraws waiting approvals; rides under way and the money owed are untouched.
 */
interface Row {
  id: string;
  name: string;
  status: OrgStatus;
  members: number;
  rides: number;
  spend: number;
  outstanding: number;
  created_at: Date;
}

const toRow = (r: Row): AdminOrganizationRow => ({
  id: r.id,
  name: r.name,
  status: r.status,
  members: r.members,
  ridesThisMonth: r.rides,
  spendThisMonthNpr: r.spend,
  outstandingNpr: r.outstanding,
  createdAt: r.created_at.toISOString(),
});

const SELECT = `SELECT o.id, o.name, o.status, o.created_at,
  (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id AND m.status = 'ACTIVE') AS members,
  (SELECT count(*)::int FROM trips t WHERE t.organization_id = o.id AND t.requested_at >= date_trunc('month', now())) AS rides,
  (SELECT COALESCE(sum(${ORG_TRIP_COST_SQL}), 0)::int FROM trips t
     WHERE t.organization_id = o.id AND t.requested_at >= date_trunc('month', now())) AS spend,
  (SELECT COALESCE(sum(p.amount_npr), 0)::int FROM trip_payments p JOIN trips t ON t.id = p.trip_id
     WHERE t.organization_id = o.id AND p.method = 'ORGANIZATION' AND p.status = 'PENDING') AS outstanding
  FROM organizations o`;

export async function listOrganizations(f: {
  status?: OrgStatus | undefined;
  search?: string | undefined;
  page: number;
  pageSize: number;
}): Promise<{ items: AdminOrganizationRow[]; total: number }> {
  const params = [f.status ?? null, f.search ? likeContains(f.search) : null];
  const where = `WHERE ($1::text IS NULL OR o.status = $1) AND ($2::text IS NULL OR o.name ILIKE $2 ESCAPE '!')`;
  const [rows, count] = await Promise.all([
    query<Row>(`${SELECT} ${where} ORDER BY o.created_at DESC, o.id LIMIT $3 OFFSET $4`, [
      ...params,
      f.pageSize,
      (f.page - 1) * f.pageSize,
    ]),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM organizations o ${where}`, params),
  ]);
  return { items: rows.rows.map(toRow), total: count.rows[0]?.n ?? 0 };
}

export async function organizationDetail(
  orgId: string,
  adminId: string,
): Promise<AdminOrganizationDetail> {
  const r = await query<
    Row & {
      legal_name: string | null;
      billing_email: string | null;
      billing_contact_name: string | null;
    }
  >(
    `SELECT x.*, o2.legal_name, o2.billing_email, o2.billing_contact_name
     FROM (${SELECT} WHERE o.id = $1) x JOIN organizations o2 ON o2.id = x.id`,
    [orgId],
  );
  const o = r.rows[0];
  if (!o) throw new HttpError(404, 'NOT_FOUND', 'Organization not found.');
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'ORG_VIEWED_BY_STAFF',
    subjectType: 'organization',
    subjectIds: [orgId],
  });
  const owners = await query<{ user_id: string; full_name: string | null }>(
    `SELECT m.user_id, u.full_name FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.role = 'OWNER' AND m.status = 'ACTIVE' ORDER BY u.full_name`,
    [orgId],
  );
  return {
    ...toRow(o),
    legalName: o.legal_name,
    billingEmail: o.billing_email,
    billingContactName: o.billing_contact_name,
    policy: await getPolicy(orgId),
    owners: owners.rows.map((x) => ({ userId: x.user_id, name: x.full_name })),
    statements: await listStatements(orgId),
    audit: await auditTrail('organization', orgId),
    allowedNext: ORG_STATUS_MOVES[o.status],
  };
}

/** Suspend an active organization or reactivate a suspended one: one guarded move, with a reason, audited. */
export async function moveOrganization(
  orgId: string,
  adminId: string,
  to: OrgStatus,
  reason: string,
): Promise<void> {
  const from = ORG_STATUS_MOVES[to];
  const done = await withTransaction(async (c) => {
    const r = await c.query(
      `UPDATE organizations SET status = $2, updated_at = now() WHERE id = $1 AND status = $3`,
      [orgId, to, from],
    );
    if (!r.rowCount) {
      const exists = await c.query('SELECT status FROM organizations WHERE id = $1', [orgId]);
      if (!exists.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Organization not found.');
      throw new HttpError(
        409,
        'ILLEGAL_MOVE',
        `The organization is already ${String(exists.rows[0].status).toLowerCase()}.`,
      );
    }
    if (to === 'SUSPENDED') {
      await c.query(
        `UPDATE organization_approvals SET status = 'CANCELLED', decided_at = now(),
           decision_note = 'The organization was suspended.'
         WHERE organization_id = $1 AND status = 'PENDING'`,
        [orgId],
      );
    }
    return true;
  });
  if (!done) return;
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: to === 'SUSPENDED' ? 'ORG_SUSPENDED' : 'ORG_REACTIVATED',
    subjectType: 'organization',
    subjectIds: [orgId],
    detail: { reason },
  });
  for (const id of await membersWithRoles(orgId, ['OWNER', 'ADMIN'])) {
    await notifyPerson(
      id,
      to === 'SUSPENDED' ? ORG_NOTIFICATION_TYPES.SUSPENDED : ORG_NOTIFICATION_TYPES.REACTIVATED,
      to === 'SUSPENDED'
        ? 'Your organization is suspended: new business rides cannot be booked. Please contact Yatri support.'
        : 'Your organization is active again. Business rides can be booked.',
      { organizationId: orgId },
    );
  }
}
