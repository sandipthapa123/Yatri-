import { isoOrNull } from '../../lib/dates';
import { pageSizeParam } from '../../lib/pagination';
import {
  DISABILITY_ADMIN_ACTION_LABELS,
  DISABILITY_ADMIN_ACTION_TARGET,
  DISABILITY_METHODS,
  DISABILITY_MESSAGE_MAX,
  DISABILITY_REASON_MAX,
  DISABILITY_REASON_MIN,
  DISABILITY_STATUS_LABELS,
  DISABILITY_VERIFICATION_STATUSES,
  disabilityAdminActionsFrom,
  type AdminDisabilityDetail,
  type AdminDisabilityEvent,
  type AdminDisabilityList,
  type AdminDisabilityRow,
  type DisabilityBenefitsOverview,
  type ApiResponse,
  type DisabilityAdminAction,
  type DisabilityActor,
  type DisabilityMethod,
  type DisabilityVerificationStatus,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { env } from '../../config/env';
import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { requireParam } from '../../lib/params';
import { getStorageProvider } from '../../lib/storage';
import { HttpError } from '../../middleware/errorHandler';
import { settingBool, settingNumber } from '../settings/settings.service';
import { columnsFor, consentActive, duplicateCount, staffMove, type VerificationRow } from '../disability/verification.service';

/**
 * The verification workspace for staff. Reading a list or a case needs DISABILITY_VERIFICATION_VIEW; a decision, and opening
 * the card's document, need DISABILITY_VERIFICATION_REVIEW (named on the routes). The card number is never in an answer:
 * staff see the last four characters, the issuer, the dates and the document, and every decision and every opening of the
 * document is audited.
 */
type Res<T> = Response<ApiResponse<T>>;
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};

/**
 * The benefit side of the workspace: the benefit policies (ordinary campaigns of the disability-benefit kind) with how much each
 * has been used, the accessible-ride service options (platform settings), and what looks unusual for a person to review. It holds
 * counts and references only: no card, no document, no identity.
 */
export async function disabilityBenefitsOverviewHandler(_req: Request, res: Res<DisabilityBenefitsOverview>) {
  const policies = await query<{ id: string; name: string; status: string; kind: string; uses: string; discount: string; riders: string }>(
    `SELECT c.id, c.name, c.status, c.kind,
            count(r.id) FILTER (WHERE r.status <> 'VOID')::text AS uses,
            COALESCE(sum(r.discount_npr) FILTER (WHERE r.status = 'APPLIED'), 0)::text AS discount,
            count(DISTINCT r.user_id) FILTER (WHERE r.status <> 'VOID')::text AS riders
     FROM campaigns c LEFT JOIN campaign_redemptions r ON r.campaign_id = c.id
     WHERE c.kind = 'DISABILITY_BENEFIT' OR c.eligibility @> '{"requiresDisabilityVerified": true}'::jsonb
     GROUP BY c.id ORDER BY c.created_at DESC LIMIT 100`,
  );
  const review = await query<{ id: string; user_id: string; rule_code: string; points: number; created_at: Date; full_name: string | null }>(
    `SELECT e.id, e.user_id, e.rule_code, e.points, e.created_at, u.full_name
     FROM risk_events e JOIN users u ON u.id = e.user_id
     WHERE e.status = 'OPEN' AND e.rule_code IN ('DISABILITY_BENEFIT_BURST', 'DISABILITY_DUPLICATE_CARD', 'DISABILITY_REPEATED_SUBMISSIONS')
     ORDER BY e.created_at DESC LIMIT 50`,
  );
  const waiting = await query<{ n: number }>(`SELECT count(*)::int AS n FROM disability_verifications WHERE status IN ('SUBMITTED', 'UNDER_REVIEW')`);
  res.json({
    success: true,
    data: {
      waitingForReview: waiting.rows[0]?.n ?? 0,
      policies: policies.rows.map((p) => ({
        campaignId: p.id,
        name: p.name,
        status: p.status as DisabilityBenefitsOverview['policies'][number]['status'],
        uses: Number(p.uses),
        discountNpr: Number(p.discount),
        distinctRiders: Number(p.riders),
      })),
      serviceOptions: {
        extraBoardingSeconds: settingNumber('EXTRA_BOARDING_SECONDS'),
        accessibleSearchRadiusBonusPercent: settingNumber('ACCESSIBLE_SEARCH_RADIUS_BONUS_PERCENT'),
        verificationEnabled: settingBool('DISABILITY_VERIFICATION_ENABLED'),
        officialCheckOffered: settingBool('DISABILITY_OFFICIAL_API_ENABLED'),
      },
      toReview: review.rows.map((r) => ({
        riskEventId: r.id,
        userId: r.user_id,
        userName: r.full_name,
        rule: r.rule_code,
        points: r.points,
        at: r.created_at.toISOString(),
      })),
    },
  });
}

export const disabilityListQuerySchema = z.object({
  status: z.enum(DISABILITY_VERIFICATION_STATUSES).optional(),
  method: z.enum(DISABILITY_METHODS).optional(),
  duplicate: z.enum(['true', 'false']).optional(),
  limit: pageSizeParam(100, 25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const disabilityActionBodySchema = z
  .object({
    note: z.string().trim().min(DISABILITY_REASON_MIN).max(DISABILITY_REASON_MAX).optional(),
    reason: z.string().trim().min(DISABILITY_REASON_MIN).max(DISABILITY_REASON_MAX).optional(),
    message: z.string().trim().min(DISABILITY_REASON_MIN).max(DISABILITY_MESSAGE_MAX).optional(),
    acknowledgeDuplicate: z.boolean().optional(),
  })
  .strict();

interface ListRow extends VerificationRow {
  full_name: string | null;
  duplicates: number;
}

const toRow = (r: ListRow): AdminDisabilityRow => ({
  id: r.id,
  userId: r.user_id,
  userName: r.full_name,
  status: r.status,
  statusLabel: DISABILITY_STATUS_LABELS[r.status],
  method: r.method,
  verifiedMethod: r.verified_method,
  cardLast4: r.card_last4,
  issuingAuthority: r.issuing_authority,
  expiryDate: r.expiry_date,
  submittedAt: isoOrNull(r.submitted_at),
  updatedAt: r.updated_at.toISOString(),
  duplicateCount: r.duplicates,
  hasDocument: !!r.document_key,
});

const DUPLICATES_SQL = `(SELECT count(*)::int FROM disability_verifications o
  WHERE o.card_hash IS NOT NULL AND o.card_hash = v.card_hash AND o.id <> v.id
    AND o.status IN ('SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'NEEDS_CORRECTION'))`;

export async function listDisabilityHandler(req: Request, res: Res<AdminDisabilityList>) {
  const q = req.validatedQuery as z.infer<typeof disabilityListQuerySchema>;
  const where = `WHERE v.status <> 'NOT_SUBMITTED'
    AND ($1::text IS NULL OR v.status = $1) AND ($2::text IS NULL OR v.method = $2)
    AND ($3::boolean IS NULL OR (${DUPLICATES_SQL} > 0) = $3)`;
  const args = [q.status ?? null, q.method ?? null, q.duplicate === undefined ? null : q.duplicate === 'true'];
  const [rows, total] = await Promise.all([
    query<ListRow>(
      `SELECT ${columnsFor('v')},
              u.full_name, ${DUPLICATES_SQL} AS duplicates
       FROM disability_verifications v JOIN users u ON u.id = v.user_id ${where}
       ORDER BY (v.status IN ('SUBMITTED', 'UNDER_REVIEW')) DESC, v.submitted_at ASC NULLS LAST, v.updated_at DESC
       LIMIT $4 OFFSET $5`,
      [...args, q.limit, q.offset],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM disability_verifications v ${where}`, args),
  ]);
  res.json({ success: true, data: { items: rows.rows.map(toRow), total: total.rows[0]?.n ?? 0, limit: q.limit, offset: q.offset } });
}

async function loadCase(id: string): Promise<ListRow> {
  const r = await query<ListRow>(
    `SELECT ${columnsFor('v')}, u.full_name, 0 AS duplicates
     FROM disability_verifications v JOIN users u ON u.id = v.user_id WHERE v.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Verification not found.');
  return row;
}

export async function getDisabilityHandler(req: Request, res: Res<AdminDisabilityDetail>) {
  const id = requireParam(req, 'id');
  const row = await loadCase(id);
  const consent = await consentActive(row.user_id);
  const dupes = row.card_hash
    ? await query<{ id: string; status: DisabilityVerificationStatus }>(
        `SELECT id, status FROM disability_verifications WHERE card_hash = $1 AND id <> $2 ORDER BY updated_at DESC LIMIT 20`,
        [row.card_hash, row.id],
      )
    : { rows: [] as Array<{ id: string; status: DisabilityVerificationStatus }> };
  const events = await query<{
    id: string; created_at: Date; from_status: DisabilityVerificationStatus; to_status: DisabilityVerificationStatus;
    actor_kind: DisabilityActor; method: DisabilityMethod | null; note: string | null; actor_name: string | null;
  }>(
    `SELECT e.id, e.created_at, e.from_status, e.to_status, e.actor_kind, e.method, e.note, a.full_name AS actor_name
     FROM disability_verification_events e LEFT JOIN users a ON a.id = e.actor_id
     WHERE e.verification_id = $1 ORDER BY e.created_at, e.id`,
    [id],
  );
  const history: AdminDisabilityEvent[] = events.rows.map((e) => ({
    id: e.id,
    at: e.created_at.toISOString(),
    fromStatus: e.from_status,
    toStatus: e.to_status,
    toLabel: DISABILITY_STATUS_LABELS[e.to_status],
    actorKind: e.actor_kind,
    actorName: e.actor_name,
    method: e.method,
    note: e.note,
  }));
  await recordAudit({ actorId: adminId(req), actorRole: 'ADMIN', action: 'DISABILITY_CASE_VIEWED', subjectType: 'disability_verification', subjectIds: [id], detail: {} });
  res.json({
    success: true,
    data: {
      ...toRow({ ...row, duplicates: await duplicateCount(row) }),
      issueDate: row.issue_date,
      message: row.message,
      consentActive: consent.active,
      consentGivenAt: isoOrNull(consent.givenAt),
      decidedAt: isoOrNull(row.decided_at),
      verifiedAt: isoOrNull(row.verified_at),
      validUntil: row.valid_until,
      duplicates: dupes.rows.map((d) => ({ verificationId: d.id, status: d.status })),
      document: row.document_key
        ? { name: row.document_name ?? 'Card document', mimeType: row.document_mime ?? '', sizeBytes: row.document_size ?? 0, uploadedAt: row.document_uploaded_at?.toISOString() ?? '' }
        : null,
      history,
      allowedActions: disabilityAdminActionsFrom(row.status),
    },
  });
}

/** A short-lived link to the card's document. Opening it is audited. */
export async function disabilityDocumentHandler(req: Request, res: Res<{ url: string; expiresInSeconds: number }>) {
  const id = requireParam(req, 'id');
  const row = await loadCase(id);
  if (!row.document_key) throw new HttpError(404, 'NOT_FOUND', 'No document was added.');
  const url = await getStorageProvider().createTemporaryAccessUrl(row.document_key, env.STORAGE_SIGNED_URL_TTL_SECONDS, {
    contentType: row.document_mime ?? undefined,
    filename: row.document_name ?? undefined,
  });
  await recordAudit({ actorId: adminId(req), actorRole: 'ADMIN', action: 'DISABILITY_DOCUMENT_VIEWED', subjectType: 'disability_verification', subjectIds: [id], detail: {} });
  res.json({ success: true, data: { url, expiresInSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS } });
}

/** One handler for the five actions: the action is the route, and what each needs is the one table in @yatri/types. */
export function disabilityActionHandler(action: DisabilityAdminAction) {
  return async (req: Request, res: Res<AdminDisabilityDetail | { ok: true }>) => {
    const body = req.body as z.infer<typeof disabilityActionBodySchema>;
    const needs = DISABILITY_ADMIN_ACTION_LABELS[action].needs;
    const text = needs === 'reason' ? body.reason : needs === 'message' ? body.message : body.note;
    if (needs !== 'none' && !text) {
      throw new HttpError(400, 'VALIDATION_ERROR', needs === 'reason' ? 'Please give a reason.' : 'Please write the correction the rider should make.');
    }
    await staffMove(requireParam(req, 'id'), {
      to: DISABILITY_ADMIN_ACTION_TARGET[action],
      adminId: adminId(req),
      note: text ?? null,
      acknowledgeDuplicate: body.acknowledgeDuplicate,
    });
    res.json({ success: true, data: { ok: true } });
  };
}

