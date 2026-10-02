import {
  CAMPAIGN_KINDS,
  CAMPAIGN_KIND_HAS_OFFER,
  CAMPAIGN_MESSAGE_BODY_MAX,
  CAMPAIGN_MESSAGE_TITLE_MAX,
  CAMPAIGN_NAME_MAX,
  CAMPAIGN_TRANSITIONS,
  OFFER_TYPES,
  campaignPhase,
  campaignProblem,
  type AdminCampaignBody,
  type CampaignEligibility,
  type CampaignInfo,
  type CampaignKind,
  type CampaignOffer,
  type CampaignStatus,
} from '@yatri/types';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';

/**
 * Campaigns as data: created, edited, scheduled, started, paused and ended here, and nowhere else. The rules
 * (is it valid, who is eligible, what it takes off) are in @yatri/types and applied by the engine; this module only
 * stores and audits them. Every change names the version it was based on (two administrators cannot overwrite each
 * other) and carries a reason in the audit log. A live campaign cannot be edited: pause it first, so a ride in
 * progress never sees an offer change under it.
 */
export interface CampaignRow {
  id: string;
  kind: CampaignKind;
  name: string;
  description: string;
  code: string | null;
  status: CampaignStatus;
  starts_at: Date | null;
  ends_at: Date | null;
  eligibility: CampaignEligibility;
  offer: CampaignOffer | null;
  referrer_points: number | null;
  stackable: boolean;
  per_user_limit: number | null;
  total_limit: number | null;
  valid_days_after_grant: number | null;
  message: { title: string; body: string } | null;
  sent_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  redemptions?: string;
}

export const CAMPAIGN_COLUMNS = `c.id, c.kind, c.name, c.description, c.code, c.status, c.starts_at, c.ends_at,
  c.eligibility, c.offer, c.referrer_points, c.stackable, c.per_user_limit, c.total_limit, c.valid_days_after_grant,
  c.message, c.sent_at, c.version, c.created_at, c.updated_at`;

export const toCampaign = (r: CampaignRow, now = new Date()): CampaignInfo => {
  const base = {
    status: r.status,
    startsAt: r.starts_at?.toISOString() ?? null,
    endsAt: r.ends_at?.toISOString() ?? null,
  };
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    code: r.code,
    ...base,
    phase: campaignPhase(base, now),
    eligibility: r.eligibility ?? {},
    offer: r.offer,
    referrerPoints: r.referrer_points,
    stackable: r.stackable,
    limits: {
      perUser: r.per_user_limit,
      total: r.total_limit,
      validDaysAfterGrant: r.valid_days_after_grant,
    },
    message: r.message,
    sentAt: r.sent_at?.toISOString() ?? null,
    redemptions: Number(r.redemptions ?? 0),
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
};

const eligibilitySchema = z
  .object({
    maxCompletedRides: z.number().int().min(0).max(100_000).optional(),
    minCompletedRides: z.number().int().min(0).max(100_000).optional(),
    newUserWithinDays: z.number().int().min(1).max(3650).optional(),
    inactiveForDays: z.number().int().min(1).max(3650).optional(),
    vehicleCategoryCodes: z
      .array(z.string().regex(/^[A-Z0-9_]{2,20}$/))
      .max(20)
      .optional(),
    cityIds: z.array(z.string().uuid()).max(50).optional(),
    minFareNpr: z.number().int().min(1).max(1_000_000).optional(),
    userIds: z.array(z.string().uuid()).max(5000).optional(),
  })
  .strict();

const offerSchema = z
  .object({
    type: z.enum(OFFER_TYPES),
    percent: z.number().min(0.1).max(100).optional(),
    fixedNpr: z.number().int().min(1).max(100_000).optional(),
    maxDiscountNpr: z.number().int().min(1).max(100_000).optional(),
    points: z.number().int().min(1).max(100_000).optional(),
    multiplier: z.number().min(1.1).max(10).optional(),
  })
  .strict();

const limit = z.number().int().min(1).max(100_000_000).nullable();
export const campaignBodySchema = z
  .object({
    kind: z.enum(CAMPAIGN_KINDS),
    name: z.string().trim().min(3).max(CAMPAIGN_NAME_MAX),
    description: z.string().trim().max(500),
    code: z.string().trim().toUpperCase().nullable(),
    startsAt: z.string().datetime().nullable(),
    endsAt: z.string().datetime().nullable(),
    eligibility: eligibilitySchema,
    offer: offerSchema.nullable(),
    referrerPoints: z.number().int().min(0).max(100_000).nullable(),
    stackable: z.boolean(),
    limits: z.object({ perUser: limit, total: limit, validDaysAfterGrant: limit }).strict(),
    message: z
      .object({
        title: z.string().trim().min(1).max(CAMPAIGN_MESSAGE_TITLE_MAX),
        body: z.string().trim().min(1).max(CAMPAIGN_MESSAGE_BODY_MAX),
      })
      .strict()
      .nullable(),
    version: z.number().int().min(1).optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

export const statusBodySchema = z
  .object({
    to: z.enum(['ACTIVE', 'PAUSED', 'ENDED']),
    version: z.number().int().min(1),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Campaign not found.');

const SELECT = `SELECT ${CAMPAIGN_COLUMNS},
  (SELECT count(*) FROM campaign_redemptions r WHERE r.campaign_id = c.id AND r.status <> 'VOID')::text AS redemptions
  FROM campaigns c`;

export async function listCampaigns(
  f: { kind?: CampaignKind; status?: CampaignStatus } = {},
): Promise<CampaignInfo[]> {
  const r = await query<CampaignRow>(
    `${SELECT} WHERE ($1::text IS NULL OR c.kind = $1) AND ($2::text IS NULL OR c.status = $2)
     ORDER BY (c.status = 'ACTIVE') DESC, c.created_at DESC LIMIT 300`,
    [f.kind ?? null, f.status ?? null],
  );
  return r.rows.map((x) => toCampaign(x));
}

export async function getCampaign(id: string): Promise<CampaignInfo> {
  const r = await query<CampaignRow>(`${SELECT} WHERE c.id = $1`, [id]);
  if (!r.rows[0]) throw notFound();
  return toCampaign(r.rows[0]);
}

async function check(b: AdminCampaignBody) {
  const problem = campaignProblem(b);
  if (problem) throw new HttpError(400, 'VALIDATION_ERROR', problem);
  const cities = b.eligibility.cityIds ?? [];
  if (cities.length > 0) {
    const have = await query('SELECT 1 FROM cities WHERE id = ANY($1::uuid[])', [cities]);
    if (have.rowCount !== cities.length)
      throw new HttpError(400, 'VALIDATION_ERROR', 'One of the cities does not exist.');
  }
  const cats = b.eligibility.vehicleCategoryCodes ?? [];
  if (cats.length > 0) {
    const have = await query('SELECT 1 FROM vehicle_categories WHERE code = ANY($1::text[])', [
      cats,
    ]);
    if (have.rowCount !== cats.length)
      throw new HttpError(400, 'VALIDATION_ERROR', 'One of the vehicle types does not exist.');
  }
}

const params = (b: AdminCampaignBody) => [
  b.name,
  b.description,
  b.code,
  b.startsAt,
  b.endsAt,
  JSON.stringify(b.eligibility),
  b.offer ? JSON.stringify(b.offer) : null,
  b.referrerPoints,
  b.stackable,
  b.limits.perUser,
  b.limits.total,
  b.limits.validDaysAfterGrant,
  b.message ? JSON.stringify(b.message) : null,
];

const uniqueCode = (err: unknown) => {
  if ((err as { code?: string }).code === '23505') {
    return new HttpError(409, 'CODE_IN_USE', 'Another campaign already uses that code.');
  }
  return err;
};

export async function createCampaign(b: AdminCampaignBody, adminId: string): Promise<CampaignInfo> {
  await check(b);
  try {
    const r = await query<{ id: string }>(
      `INSERT INTO campaigns (kind, name, description, code, starts_at, ends_at, eligibility, offer, referrer_points,
         stackable, per_user_limit, total_limit, valid_days_after_grant, message, created_by)
       VALUES ($14, $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $15) RETURNING id`,
      [...params(b), b.kind, adminId],
    );
    const id = (r.rows[0] as { id: string }).id;
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'CAMPAIGN_CREATED',
      subjectType: 'campaign',
      subjectIds: [id],
      detail: { kind: b.kind, name: b.name, reason: b.reason },
    });
    return getCampaign(id);
  } catch (err) {
    throw uniqueCode(err);
  }
}

export async function updateCampaign(
  id: string,
  b: AdminCampaignBody,
  adminId: string,
): Promise<CampaignInfo> {
  await check(b);
  try {
    await withTransaction(async (c) => {
      const cur = await c.query<{ status: CampaignStatus; kind: CampaignKind; version: number }>(
        'SELECT status, kind, version FROM campaigns WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = cur.rows[0];
      if (!row) throw notFound();
      if (b.version !== undefined && b.version !== row.version) {
        throw new HttpError(
          409,
          'VERSION_CONFLICT',
          'Someone else changed this campaign. Reload it and try again.',
        );
      }
      if (row.kind !== b.kind)
        throw new HttpError(
          409,
          'KIND_LOCKED',
          'The kind of a campaign cannot be changed. Create a new one.',
        );
      if (row.status === 'ACTIVE') {
        throw new HttpError(
          409,
          'CAMPAIGN_LIVE',
          'A running campaign cannot be edited. Pause it first.',
        );
      }
      if (row.status === 'ENDED')
        throw new HttpError(409, 'CAMPAIGN_ENDED', 'An ended campaign cannot be edited.');
      await c.query(
        `UPDATE campaigns SET name = $2, description = $3, code = $4, starts_at = $5, ends_at = $6,
           eligibility = $7::jsonb, offer = $8::jsonb, referrer_points = $9, stackable = $10, per_user_limit = $11,
           total_limit = $12, valid_days_after_grant = $13, message = $14::jsonb, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, ...params(b)],
      );
      await recordAudit({
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'CAMPAIGN_UPDATED',
        subjectType: 'campaign',
        subjectIds: [id],
        detail: { name: b.name, reason: b.reason },
      });
    });
  } catch (err) {
    throw uniqueCode(err);
  }
  return getCampaign(id);
}

/** Start, pause or end a campaign: only the moves in CAMPAIGN_TRANSITIONS, under the row lock, with the reason audited. */
export async function transitionCampaign(
  id: string,
  to: CampaignStatus,
  version: number,
  reason: string,
  adminId: string,
): Promise<CampaignInfo> {
  await withTransaction(async (c) => {
    const cur = await c.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = cur.rows[0];
    if (!row) throw notFound();
    if (row.version !== version) {
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'Someone else changed this campaign. Reload it and try again.',
      );
    }
    if (!CAMPAIGN_TRANSITIONS[row.status].includes(to)) {
      throw new HttpError(
        409,
        'INVALID_TRANSITION',
        `A ${row.status.toLowerCase()} campaign cannot become ${to.toLowerCase()}.`,
      );
    }
    if (to === 'ACTIVE') {
      const problem = campaignProblem({
        kind: row.kind,
        name: row.name,
        description: row.description,
        code: row.code,
        startsAt: row.starts_at?.toISOString() ?? null,
        endsAt: row.ends_at?.toISOString() ?? null,
        eligibility: row.eligibility,
        offer: row.offer,
        referrerPoints: row.referrer_points,
        stackable: row.stackable,
        limits: {
          perUser: row.per_user_limit,
          total: row.total_limit,
          validDaysAfterGrant: row.valid_days_after_grant,
        },
        message: row.message,
      });
      if (problem) throw new HttpError(409, 'CAMPAIGN_INVALID', problem);
      if (row.ends_at && row.ends_at <= new Date()) {
        throw new HttpError(
          409,
          'CAMPAIGN_INVALID',
          'Its end date has already passed. Change the dates first.',
        );
      }
    }
    await c.query(
      'UPDATE campaigns SET status = $2, version = version + 1, updated_at = now() WHERE id = $1',
      [id, to],
    );
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: `CAMPAIGN_${to}`,
      subjectType: 'campaign',
      subjectIds: [id],
      detail: { from: row.status, to, reason },
    });
  });
  return getCampaign(id);
}

export const campaignHasOffer = (k: CampaignKind) => CAMPAIGN_KIND_HAS_OFFER[k];
