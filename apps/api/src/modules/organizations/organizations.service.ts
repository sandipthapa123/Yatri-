import {
  DEFAULT_ORG_POLICY,
  ORG_ROLE_PERMISSIONS,
  type CreateOrganizationBody,
  type OrgInvitationInfo,
  type OrgRole,
  type OrgStatus,
  type OrganizationInfo,
  type UpdateOrganizationBody,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { settingNumber } from '../settings/settings.service';

/**
 * Organizations: a business account owned by rider accounts. Whoever creates one becomes its first OWNER and it
 * starts with the default policy. Everything else about who may do what is the organization role table in
 * @yatri/types; the platform only suspends or reactivates (organizations/admin side), never edits an
 * organization's own settings.
 */
interface Row {
  id: string;
  name: string;
  legal_name: string | null;
  billing_email: string | null;
  billing_contact_name: string | null;
  status: OrgStatus;
  created_at: Date;
  role: OrgRole;
}

const toInfo = (r: Row): OrganizationInfo => ({
  id: r.id,
  name: r.name,
  legalName: r.legal_name,
  billingEmail: r.billing_email,
  billingContactName: r.billing_contact_name,
  status: r.status,
  myRole: r.role,
  myPermissions: [...ORG_ROLE_PERMISSIONS[r.role]],
  createdAt: r.created_at.toISOString(),
});

const SELECT = `SELECT o.id, o.name, o.legal_name, o.billing_email, o.billing_contact_name, o.status, o.created_at, m.role
  FROM organizations o JOIN organization_members m ON m.organization_id = o.id`;

export async function createOrganization(
  userId: string,
  body: CreateOrganizationBody,
): Promise<OrganizationInfo> {
  const id = await withTransaction(async (c) => {
    // Serialise one person's creations so the per-person limit cannot be passed by two at once.
    await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const owned = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM organization_members WHERE user_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`,
      [userId],
    );
    const limit = settingNumber('ORG_MAX_PER_USER');
    if ((owned.rows[0]?.n ?? 0) >= limit) {
      throw new HttpError(
        409,
        'TOO_MANY_ORGANIZATIONS',
        `You can own at most ${limit} organizations. Contact Yatri if you need more.`,
      );
    }
    const o = await c.query<{ id: string }>(
      `INSERT INTO organizations (name, legal_name, billing_email, billing_contact_name, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        body.name,
        body.legalName ?? null,
        body.billingEmail ?? null,
        body.billingContactName ?? null,
        userId,
      ],
    );
    const orgId = o.rows[0]?.id as string;
    await c.query(
      `INSERT INTO organization_policies (organization_id, member_self_booking, cost_center_required, payment_mode)
       VALUES ($1, $2, $3, $4)`,
      [
        orgId,
        DEFAULT_ORG_POLICY.memberSelfBooking,
        DEFAULT_ORG_POLICY.costCenterRequired,
        DEFAULT_ORG_POLICY.paymentMode,
      ],
    );
    await c.query(
      `INSERT INTO organization_members (organization_id, user_id, role, status, invited_by, joined_at)
       VALUES ($1, $2, 'OWNER', 'ACTIVE', $2, now())`,
      [orgId, userId],
    );
    return orgId;
  });
  await recordAudit({
    actorId: userId,
    actorRole: 'PASSENGER',
    action: 'ORG_CREATED',
    subjectType: 'organization',
    subjectIds: [id],
    detail: { name: body.name },
  });
  return getOrganization(id, userId);
}

export async function getOrganization(orgId: string, userId: string): Promise<OrganizationInfo> {
  const r = await query<Row>(
    `${SELECT} WHERE o.id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE'`,
    [orgId, userId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Organization not found.');
  return toInfo(r.rows[0]);
}

export async function myOrganizations(userId: string): Promise<OrganizationInfo[]> {
  const r = await query<Row>(
    `${SELECT} WHERE m.user_id = $1 AND m.status = 'ACTIVE' ORDER BY o.name`,
    [userId],
  );
  return r.rows.map(toInfo);
}

export async function myInvitations(userId: string): Promise<OrgInvitationInfo[]> {
  const r = await query<{ organization_id: string; name: string; role: OrgRole; invited_at: Date }>(
    `SELECT m.organization_id, o.name, m.role, m.invited_at
     FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND m.status = 'INVITED' ORDER BY m.invited_at DESC`,
    [userId],
  );
  return r.rows.map((i) => ({
    organizationId: i.organization_id,
    organizationName: i.name,
    role: i.role,
    invitedAt: i.invited_at.toISOString(),
  }));
}

export async function updateOrganization(
  orgId: string,
  userId: string,
  body: UpdateOrganizationBody,
): Promise<OrganizationInfo> {
  await query(
    `UPDATE organizations SET name = $2, legal_name = $3, billing_email = $4, billing_contact_name = $5, updated_at = now()
     WHERE id = $1`,
    [
      orgId,
      body.name,
      body.legalName ?? null,
      body.billingEmail ?? null,
      body.billingContactName ?? null,
    ],
  );
  await recordAudit({
    actorId: userId,
    actorRole: 'PASSENGER',
    action: 'ORG_UPDATED',
    subjectType: 'organization',
    subjectIds: [orgId],
    detail: { name: body.name },
  });
  return getOrganization(orgId, userId);
}
