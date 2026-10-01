import {
  ORG_LIMIT_MAX_NPR,
  ORG_PAYMENT_MODES,
  type CostCenterBody,
  type OrgCostCenterInfo,
  type OrgPolicy,
  type OrgPolicyView,
} from '@yatri/types';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { listActiveCategories } from '../pricing/categories';
import { allZones } from '../operations/zones.service';
import type { OrgContext } from './access';

/**
 * The organization policy: ONE row per organization, read here and applied only by `evaluateBooking`
 * (@yatri/types) when a ride is booked or approved. Categories and zones are the platform's own reference
 * data; the policy only names which of them an organization may use, so a category or zone that is retired
 * simply stops matching (nothing is copied).
 */
interface PolicyRow {
  allowed_category_codes: string[];
  allowed_zone_ids: string[];
  per_ride_limit_npr: number | null;
  per_member_monthly_limit_npr: number | null;
  monthly_limit_npr: number | null;
  approval_over_npr: number | null;
  approval_for_all: boolean;
  member_self_booking: boolean;
  cost_center_required: boolean;
  payment_mode: OrgPolicy['paymentMode'];
}

const toPolicy = (r: PolicyRow): OrgPolicy => ({
  allowedCategoryCodes: r.allowed_category_codes,
  allowedZoneIds: r.allowed_zone_ids,
  perRideLimitNpr: r.per_ride_limit_npr,
  perMemberMonthlyLimitNpr: r.per_member_monthly_limit_npr,
  monthlyLimitNpr: r.monthly_limit_npr,
  approvalOverNpr: r.approval_over_npr,
  approvalForAll: r.approval_for_all,
  memberSelfBooking: r.member_self_booking,
  costCenterRequired: r.cost_center_required,
  paymentMode: r.payment_mode,
});

export async function getPolicy(orgId: string): Promise<OrgPolicy> {
  const r = await query<PolicyRow>(
    'SELECT * FROM organization_policies WHERE organization_id = $1',
    [orgId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Organization not found.');
  return toPolicy(r.rows[0]);
}

export async function getPolicyView(orgId: string): Promise<OrgPolicyView> {
  const [policy, categories, zones] = await Promise.all([
    getPolicy(orgId),
    listActiveCategories(),
    allZones(),
  ]);
  return {
    ...policy,
    categoryOptions: categories.map((c) => ({ code: c.code, label: c.label })),
    zoneOptions: zones.filter((z) => z.isActive).map((z) => ({ id: z.id, name: z.name })),
  };
}

const limit = z.number().int().min(1).max(ORG_LIMIT_MAX_NPR).nullable();
export const policySchema = z
  .object({
    allowedCategoryCodes: z.array(z.string().trim().min(1).max(40)).max(30),
    allowedZoneIds: z.array(z.string().uuid()).max(100),
    perRideLimitNpr: limit,
    perMemberMonthlyLimitNpr: limit,
    monthlyLimitNpr: limit,
    approvalOverNpr: limit,
    approvalForAll: z.boolean(),
    memberSelfBooking: z.boolean(),
    costCenterRequired: z.boolean(),
    paymentMode: z.enum(ORG_PAYMENT_MODES),
  })
  .strict();

export async function updatePolicy(ctx: OrgContext, body: OrgPolicy): Promise<OrgPolicyView> {
  const [categories, zones] = await Promise.all([listActiveCategories(), allZones()]);
  const unknownCategory = body.allowedCategoryCodes.find(
    (c) => !categories.some((k) => k.code === c),
  );
  if (unknownCategory)
    throw new HttpError(400, 'UNKNOWN_CATEGORY', `Unknown vehicle type: ${unknownCategory}.`);
  const unknownZone = body.allowedZoneIds.find((z) => !zones.some((k) => k.id === z));
  if (unknownZone)
    throw new HttpError(400, 'UNKNOWN_ZONE', 'One of the chosen areas does not exist.');
  const before = await getPolicy(ctx.orgId);
  await query(
    `UPDATE organization_policies SET allowed_category_codes = $2, allowed_zone_ids = $3::uuid[],
       per_ride_limit_npr = $4, per_member_monthly_limit_npr = $5, monthly_limit_npr = $6,
       approval_over_npr = $7, approval_for_all = $8, member_self_booking = $9, cost_center_required = $10,
       payment_mode = $11, updated_at = now()
     WHERE organization_id = $1`,
    [
      ctx.orgId,
      body.allowedCategoryCodes,
      body.allowedZoneIds,
      body.perRideLimitNpr,
      body.perMemberMonthlyLimitNpr,
      body.monthlyLimitNpr,
      body.approvalOverNpr,
      body.approvalForAll,
      body.memberSelfBooking,
      body.costCenterRequired,
      body.paymentMode,
    ],
  );
  await recordAudit({
    actorId: ctx.userId,
    actorRole: 'PASSENGER',
    action: 'ORG_POLICY_CHANGED',
    subjectType: 'organization',
    subjectIds: [ctx.orgId],
    detail: { from: before, to: body },
  });
  return getPolicyView(ctx.orgId);
}

// ---------------------------------------------------------------- cost centres (the department tags)

interface CostCenterRow {
  id: string;
  code: string;
  name: string;
  department: string | null;
  is_active: boolean;
}
const toCostCenter = (r: CostCenterRow): OrgCostCenterInfo => ({
  id: r.id,
  code: r.code,
  name: r.name,
  department: r.department,
  isActive: r.is_active,
});

export async function listCostCenters(orgId: string): Promise<OrgCostCenterInfo[]> {
  const r = await query<CostCenterRow>(
    'SELECT id, code, name, department, is_active FROM organization_cost_centers WHERE organization_id = $1 ORDER BY lower(code)',
    [orgId],
  );
  return r.rows.map(toCostCenter);
}

export const costCenterSchema = z
  .object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(100),
    department: z.string().trim().max(100).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict();

export async function saveCostCenter(
  ctx: OrgContext,
  id: string | null,
  body: CostCenterBody,
): Promise<OrgCostCenterInfo> {
  try {
    const r = id
      ? await query<CostCenterRow>(
          `UPDATE organization_cost_centers SET code = $3, name = $4, department = $5, is_active = COALESCE($6, is_active)
           WHERE id = $1 AND organization_id = $2 RETURNING id, code, name, department, is_active`,
          [id, ctx.orgId, body.code, body.name, body.department ?? null, body.isActive ?? null],
        )
      : await query<CostCenterRow>(
          `INSERT INTO organization_cost_centers (organization_id, code, name, department)
           VALUES ($1, $2, $3, $4) RETURNING id, code, name, department, is_active`,
          [ctx.orgId, body.code, body.name, body.department ?? null],
        );
    if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Cost centre not found.');
    await recordAudit({
      actorId: ctx.userId,
      actorRole: 'PASSENGER',
      action: id ? 'ORG_COST_CENTER_CHANGED' : 'ORG_COST_CENTER_ADDED',
      subjectType: 'organization',
      subjectIds: [ctx.orgId],
      detail: { code: body.code, active: r.rows[0].is_active },
    });
    return toCostCenter(r.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'DUPLICATE_CODE', 'A cost centre with that code already exists.');
    }
    throw err;
  }
}
