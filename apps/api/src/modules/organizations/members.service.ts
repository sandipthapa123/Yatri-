import {
  ORG_NOTIFICATION_TYPES,
  ORG_ROLE_LABELS,
  assignableOrgRoles,
  canManageOrgMember,
  orgRoleHolds,
  type ChangeMemberBody,
  type InviteMemberBody,
  type OrgMemberInfo,
  type OrgMemberStatus,
  type OrgRole,
} from '@yatri/types';
import type { PoolClient } from 'pg';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { loadContext, type OrgContext } from './access';
import { notifyPerson } from './org-notify';

/**
 * Members: invitations, roles and removal. The rules are the role table and `canManageOrgMember` /
 * `assignableOrgRoles` in @yatri/types; this applies them under a lock on the organization, which is also
 * what keeps "an organization always has an owner" true when two people change things at once.
 *
 * People are invited by phone number but nothing says whether a number has an account: an invitation to a
 * number with no rider account looks exactly like one that was sent. Nobody becomes a member without accepting.
 */
export const INVITE_ANSWER =
  'If that number belongs to a Yatri rider account, an invitation has been sent. They join when they accept it.';

const lockOrg = (c: PoolClient, orgId: string) =>
  c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);

/**
 * Lock the organization, then read the actor's role AGAIN: the role the request arrived with may have been
 * changed by someone who held the lock first, and a person demoted a moment ago must not act as before.
 */
async function lockAsActor(c: PoolClient, ctx: OrgContext): Promise<OrgRole> {
  await lockOrg(c, ctx.orgId);
  const actor = await loadContext(ctx.orgId, ctx.userId, c);
  if (!actor)
    throw new HttpError(403, 'FORBIDDEN', 'You are no longer a member of this organization.');
  return actor.role;
}

async function orgName(orgId: string): Promise<string> {
  const r = await query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId]);
  return r.rows[0]?.name ?? 'An organization';
}

export async function inviteMember(ctx: OrgContext, body: InviteMemberBody): Promise<string> {
  if (!assignableOrgRoles(ctx.role).includes(body.role)) {
    throw new HttpError(
      403,
      'FORBIDDEN',
      `Your role cannot invite someone as ${ORG_ROLE_LABELS[body.role].toLowerCase()}.`,
    );
  }
  const u = await query<{ id: string }>(
    `SELECT id FROM users WHERE phone_number = $1 AND role = 'PASSENGER' AND status = 'ACTIVE'`,
    [body.phoneNumber],
  );
  const target = u.rows[0]?.id;
  if (!target || target === ctx.userId) return INVITE_ANSWER;
  const invited = await withTransaction(async (c) => {
    const actorRole = await lockAsActor(c, ctx);
    if (!assignableOrgRoles(actorRole).includes(body.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Your role cannot invite someone with that role.');
    }
    const r = await c.query(
      `INSERT INTO organization_members (organization_id, user_id, role, status, invited_by, invited_at)
       VALUES ($1, $2, $3, 'INVITED', $4, now())
       ON CONFLICT (organization_id, user_id) DO UPDATE
         SET role = $3, status = 'INVITED', invited_by = $4, invited_at = now(), removed_at = NULL, joined_at = NULL
         WHERE organization_members.status <> 'ACTIVE'`,
      [ctx.orgId, target, body.role, ctx.userId],
    );
    return !!r.rowCount;
  });
  if (invited) {
    await recordAudit({
      actorId: ctx.userId,
      actorRole: 'PASSENGER',
      action: 'ORG_MEMBER_INVITED',
      subjectType: 'organization',
      subjectIds: [ctx.orgId],
      detail: { userId: target, role: body.role },
    });
    await notifyPerson(
      target,
      ORG_NOTIFICATION_TYPES.INVITED,
      `${await orgName(ctx.orgId)} invited you to take business rides as ${ORG_ROLE_LABELS[body.role].toLowerCase()}. Open Business to accept.`,
      { organizationId: ctx.orgId },
    );
  }
  return INVITE_ANSWER;
}

export async function answerInvitation(
  userId: string,
  orgId: string,
  accept: boolean,
): Promise<void> {
  const r = await query<{ role: OrgRole }>(
    accept
      ? `UPDATE organization_members SET status = 'ACTIVE', joined_at = now()
         WHERE organization_id = $1 AND user_id = $2 AND status = 'INVITED' RETURNING role`
      : `UPDATE organization_members SET status = 'REMOVED', removed_at = now()
         WHERE organization_id = $1 AND user_id = $2 AND status = 'INVITED' RETURNING role`,
    [orgId, userId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Invitation not found.');
  await recordAudit({
    actorId: userId,
    actorRole: 'PASSENGER',
    action: accept ? 'ORG_MEMBER_JOINED' : 'ORG_INVITATION_DECLINED',
    subjectType: 'organization',
    subjectIds: [orgId],
    detail: { role: r.rows[0].role },
  });
}

interface MemberRow {
  id: string;
  user_id: string;
  full_name: string | null;
  role: OrgRole;
  status: OrgMemberStatus;
  default_cost_center_id: string | null;
  invited_at: Date;
  joined_at: Date | null;
}

/** Who may see the member list: those who manage members, book for others or see all rides. */
export const canSeeMembers = (role: OrgRole) =>
  orgRoleHolds(role, 'MEMBERS_MANAGE') ||
  orgRoleHolds(role, 'RIDES_BOOK_FOR_OTHERS') ||
  orgRoleHolds(role, 'RIDES_VIEW_ALL');

export async function listMembers(ctx: OrgContext): Promise<OrgMemberInfo[]> {
  if (!canSeeMembers(ctx.role)) {
    throw new HttpError(403, 'FORBIDDEN', 'Your role in this organization does not allow this.');
  }
  const r = await query<MemberRow>(
    `SELECT m.id, m.user_id, u.full_name, m.role, m.status, m.default_cost_center_id, m.invited_at, m.joined_at
     FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.status <> 'REMOVED'
     ORDER BY CASE m.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END, lower(u.full_name), m.invited_at`,
    [ctx.orgId],
  );
  const manage = orgRoleHolds(ctx.role, 'MEMBERS_MANAGE');
  return r.rows.map((m) => ({
    id: m.id,
    userId: m.user_id,
    name: m.full_name,
    role: m.role,
    status: m.status,
    defaultCostCenterId: m.default_cost_center_id,
    canChange: manage && m.user_id !== ctx.userId && canManageOrgMember(ctx.role, m.role),
    invitedAt: m.invited_at.toISOString(),
    joinedAt: m.joined_at?.toISOString() ?? null,
  }));
}

async function lockMember(c: PoolClient, orgId: string, memberId: string) {
  const r = await c.query<{ id: string; user_id: string; role: OrgRole; status: OrgMemberStatus }>(
    `SELECT id, user_id, role, status FROM organization_members
     WHERE id = $1 AND organization_id = $2 AND status <> 'REMOVED' FOR UPDATE`,
    [memberId, orgId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Member not found.');
  return r.rows[0];
}

/** Another active owner exists (so this one may leave or be demoted). */
async function otherOwnerExists(c: PoolClient, orgId: string, exceptUserId: string) {
  const r = await c.query(
    `SELECT 1 FROM organization_members
     WHERE organization_id = $1 AND role = 'OWNER' AND status = 'ACTIVE' AND user_id <> $2 LIMIT 1`,
    [orgId, exceptUserId],
  );
  return !!r.rowCount;
}

export async function changeMember(
  ctx: OrgContext,
  memberId: string,
  body: ChangeMemberBody,
): Promise<OrgMemberInfo[]> {
  const result = await withTransaction(async (c) => {
    const actorRole = await lockAsActor(c, ctx);
    if (!orgRoleHolds(actorRole, 'MEMBERS_MANAGE')) {
      throw new HttpError(403, 'FORBIDDEN', 'Your role in this organization does not allow this.');
    }
    const m = await lockMember(c, ctx.orgId, memberId);
    if (m.user_id === ctx.userId) {
      throw new HttpError(
        409,
        'SELF_CHANGE',
        'You cannot change your own role. Ask another owner or administrator.',
      );
    }
    if (!canManageOrgMember(actorRole, m.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Your role cannot change this member.');
    }
    if (body.role && body.role !== m.role) {
      if (!assignableOrgRoles(actorRole).includes(body.role)) {
        throw new HttpError(403, 'FORBIDDEN', 'Your role cannot give that role.');
      }
      if (m.role === 'OWNER' && !(await otherOwnerExists(c, ctx.orgId, m.user_id))) {
        throw new HttpError(409, 'LAST_OWNER', 'An organization needs at least one owner.');
      }
    }
    if (body.defaultCostCenterId) {
      const cc = await c.query(
        'SELECT 1 FROM organization_cost_centers WHERE id = $1 AND organization_id = $2',
        [body.defaultCostCenterId, ctx.orgId],
      );
      if (!cc.rowCount)
        throw new HttpError(
          400,
          'UNKNOWN_COST_CENTER',
          'That cost centre is not in this organization.',
        );
    }
    await c.query(
      `UPDATE organization_members SET role = COALESCE($2, role),
         default_cost_center_id = CASE WHEN $4::boolean THEN $3::uuid ELSE default_cost_center_id END
       WHERE id = $1`,
      [
        memberId,
        body.role ?? null,
        body.defaultCostCenterId ?? null,
        'defaultCostCenterId' in body,
      ],
    );
    return m;
  });
  await recordAudit({
    actorId: ctx.userId,
    actorRole: 'PASSENGER',
    action: 'ORG_MEMBER_CHANGED',
    subjectType: 'organization',
    subjectIds: [ctx.orgId],
    detail: { userId: result.user_id, from: result.role, to: body.role ?? result.role },
  });
  if (body.role && body.role !== result.role) {
    await notifyPerson(
      result.user_id,
      ORG_NOTIFICATION_TYPES.ROLE_CHANGED,
      `${await orgName(ctx.orgId)}: your role is now ${ORG_ROLE_LABELS[body.role].toLowerCase()}.`,
      { organizationId: ctx.orgId },
    );
  }
  return listMembers(ctx);
}

/** Remove a member (needs MEMBERS_MANAGE and a role above theirs), or let someone leave on their own. */
export async function removeMember(ctx: OrgContext, memberId: string): Promise<void> {
  const removed = await withTransaction(async (c) => {
    const actorRole = await lockAsActor(c, ctx);
    const m = await lockMember(c, ctx.orgId, memberId);
    const self = m.user_id === ctx.userId;
    if (!self) {
      if (!orgRoleHolds(actorRole, 'MEMBERS_MANAGE') || !canManageOrgMember(actorRole, m.role)) {
        throw new HttpError(403, 'FORBIDDEN', 'Your role cannot remove this member.');
      }
    }
    if (
      m.role === 'OWNER' &&
      m.status === 'ACTIVE' &&
      !(await otherOwnerExists(c, ctx.orgId, m.user_id))
    ) {
      throw new HttpError(409, 'LAST_OWNER', 'An organization needs at least one owner.');
    }
    await c.query(
      `UPDATE organization_members SET status = 'REMOVED', removed_at = now() WHERE id = $1`,
      [memberId],
    );
    // What was waiting for a person who is no longer in the organization is withdrawn.
    await c.query(
      `UPDATE organization_approvals SET status = 'CANCELLED', decided_at = now(),
         decision_note = 'The person is no longer a member.'
       WHERE organization_id = $1 AND status = 'PENDING' AND (passenger_id = $2 OR requested_by = $2)`,
      [ctx.orgId, m.user_id],
    );
    return { userId: m.user_id, self };
  });
  await recordAudit({
    actorId: ctx.userId,
    actorRole: 'PASSENGER',
    action: removed.self ? 'ORG_MEMBER_LEFT' : 'ORG_MEMBER_REMOVED',
    subjectType: 'organization',
    subjectIds: [ctx.orgId],
    detail: { userId: removed.userId },
  });
  if (!removed.self) {
    await notifyPerson(
      removed.userId,
      ORG_NOTIFICATION_TYPES.REMOVED,
      `You were removed from ${await orgName(ctx.orgId)}.`,
      { organizationId: ctx.orgId },
    );
  }
}

/** The caller's own membership id, for leaving. */
export async function myMemberId(ctx: OrgContext): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
    [ctx.orgId, ctx.userId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Organization not found.');
  return r.rows[0].id;
}
