import {
  RISK_CATEGORIES,
  RISK_EVENT_STATUSES,
  RISK_EVENT_TRANSITIONS,
  RISK_EVIDENCE_MAX_IDS,
  riskRuleDef,
  type RiskCategory,
  type RiskEventInfo,
  type RiskEventStatus,
  type RiskEvidence,
  type RiskRuleInfo,
  type RiskUserRole,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { settingNumber } from '../settings/settings.service';
import type { DetectedRow } from './detectors';

/**
 * Risk events: signals, never verdicts. Writing one is idempotent (the dedupe key is the rule, the person and
 * the window's time bucket), a dismissed event keeps the same rule quiet for that person for two windows, and
 * the evidence is counts and record ids only. The score is the sum of the points of events that still count
 * (open or confirmed, inside the event window): it is always worked out here, never stored.
 */
export const EVENT_SELECT = `SELECT e.id, e.user_id, u.full_name, u.role, e.rule_code, e.category, e.points, e.status,
       e.evidence, e.trip_id, e.created_at, e.reviewed_at, e.review_note
     FROM risk_events e LEFT JOIN users u ON u.id = e.user_id`;

export interface EventRow {
  id: string;
  user_id: string | null;
  full_name: string | null;
  role: RiskUserRole | null;
  rule_code: string;
  category: RiskCategory;
  points: number;
  status: RiskEventStatus;
  evidence: RiskEvidence;
  trip_id: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  review_note: string | null;
}

export const toEvent = (r: EventRow): RiskEventInfo => ({
  id: r.id,
  userId: r.user_id,
  userName: r.full_name,
  userRole: r.role,
  ruleCode: r.rule_code,
  ruleLabel: riskRuleDef(r.rule_code)?.label ?? r.rule_code,
  category: r.category,
  points: r.points,
  status: r.status,
  evidence: r.evidence,
  tripId: r.trip_id,
  createdAt: r.created_at.toISOString(),
  reviewedAt: r.reviewed_at?.toISOString() ?? null,
  reviewNote: r.review_note,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (list: string[] | null | undefined) =>
  (list ?? []).filter((x) => UUID.test(x)).slice(0, RISK_EVIDENCE_MAX_IDS);

export function eventDedupeKey(
  code: string,
  userId: string,
  windowHours: number,
  now = Date.now(),
) {
  return `${code}:${userId}:${Math.floor(now / (windowHours * 3_600_000))}`;
}

/** The evidence kept for a detection: counts and ids, and nothing else. */
export function evidenceOf(rule: RiskRuleInfo, row: DetectedRow): RiskEvidence {
  const e: RiskEvidence = { count: row.count, windowHours: rule.windowHours };
  if (row.total != null) e.total = row.total;
  const trips = ids(row.trips);
  if (trips.length) e.tripIds = trips;
  const related = ids(row.related);
  if (related.length) e.relatedUserIds = related;
  if (row.kinds?.length) e.kinds = row.kinds.slice(0, 10);
  return e;
}

/** Record what a detector found. Returns the people who got a NEW event (a repeat run adds nothing). */
export async function recordSignals(rule: RiskRuleInfo, rows: DetectedRow[]): Promise<string[]> {
  const created = new Set<string>();
  for (const row of rows) {
    const evidence = evidenceOf(rule, row);
    const r = await query(
      `INSERT INTO risk_events (user_id, rule_code, category, points, evidence, trip_id, dedupe_key)
       SELECT $1::uuid, $2::text, $3::text, $4::int, $5::jsonb, $6::uuid, $7::text
       WHERE NOT EXISTS (
         SELECT 1 FROM risk_events d
         WHERE d.user_id = $1::uuid AND d.rule_code = $2::text AND d.status = 'DISMISSED'
           AND d.created_at > now() - ($8::int * interval '1 hour'))
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        row.user_id,
        rule.code,
        rule.category,
        rule.points,
        JSON.stringify(evidence),
        evidence.tripIds?.[0] ?? null,
        eventDedupeKey(rule.code, row.user_id, rule.windowHours),
        rule.windowHours * 2,
      ],
    );
    if (r.rowCount) created.add(row.user_id);
  }
  return [...created];
}

/** What counts for a person now: points, and how many different rules those points came from. */
export async function scoreFor(
  userId: string,
  since?: Date | null,
): Promise<{ score: number; rules: number }> {
  const r = await query<{ score: number; rules: number }>(
    `SELECT COALESCE(sum(points), 0)::int AS score, count(DISTINCT rule_code)::int AS rules
     FROM risk_events
     WHERE user_id = $1 AND status IN ('OPEN', 'CONFIRMED')
       AND created_at > now() - ($2::int * interval '1 day')
       AND created_at > COALESCE($3::timestamptz, '-infinity'::timestamptz)`,
    [userId, settingNumber('RISK_EVENT_WINDOW_DAYS'), since ?? null],
  );
  return r.rows[0] ?? { score: 0, rules: 0 };
}

export interface EventFilters {
  status?: RiskEventStatus | undefined;
  category?: RiskCategory | undefined;
  ruleCode?: string | undefined;
  userId?: string | undefined;
  tripId?: string | undefined;
  page: number;
  pageSize: number;
}

export async function listEvents(
  f: EventFilters,
): Promise<{ items: RiskEventInfo[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.status) add('e.status = ?', f.status);
  if (f.category) add('e.category = ?', f.category);
  if (f.ruleCode) add('e.rule_code = ?', f.ruleCode);
  if (f.userId) add('e.user_id = ?', f.userId);
  if (f.tripId) add('e.trip_id = ?', f.tripId);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, count] = await Promise.all([
    query<EventRow>(
      `${EVENT_SELECT} ${clause} ORDER BY e.created_at DESC, e.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM risk_events e ${clause}`, params),
  ]);
  return { items: rows.rows.map(toEvent), total: count.rows[0]?.n ?? 0 };
}

export async function getEvent(id: string): Promise<RiskEventInfo> {
  const r = await query<EventRow>(`${EVENT_SELECT} WHERE e.id = $1`, [id]);
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Risk event not found.');
  return toEvent(r.rows[0]);
}

/**
 * An administrator's judgement on a signal: confirmed, or dismissed as a false alarm (which stops it counting).
 * The move must be one the table in @yatri/types allows, and is applied only if the event is still in the state
 * the administrator saw, so two reviewers cannot overwrite each other unseen.
 */
export async function reviewEvent(
  eventId: string,
  to: RiskEventStatus,
  reason: string,
  adminId: string,
): Promise<RiskEventInfo> {
  if (!RISK_EVENT_STATUSES.includes(to))
    throw new HttpError(400, 'INVALID_STATUS', 'Unknown status.');
  const cur = await query<{
    status: RiskEventStatus;
    user_id: string | null;
    trip_id: string | null;
  }>('SELECT status, user_id, trip_id FROM risk_events WHERE id = $1', [eventId]);
  const event = cur.rows[0];
  if (!event) throw new HttpError(404, 'NOT_FOUND', 'Risk event not found.');
  if (!RISK_EVENT_TRANSITIONS[event.status].includes(to)) {
    throw new HttpError(
      409,
      'ILLEGAL_MOVE',
      `A ${event.status.toLowerCase()} event cannot be marked ${to.toLowerCase()}.`,
    );
  }
  const done = await query(
    `UPDATE risk_events SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
     WHERE id = $1 AND status = $5`,
    [eventId, to, adminId, reason, event.status],
  );
  if (!done.rowCount) {
    throw new HttpError(
      409,
      'CONFLICT',
      'Someone else just reviewed this event. Reload to see it.',
    );
  }
  const detail = { eventId, from: event.status, to, reason };
  const subjects = [
    event.user_id ? { type: 'risk_user', id: event.user_id } : null,
    event.trip_id ? { type: 'risk_trip', id: event.trip_id } : null,
  ].filter((s): s is { type: string; id: string } => s !== null);
  for (const s of subjects) {
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'RISK_EVENT_REVIEWED',
      subjectType: s.type,
      subjectIds: [s.id],
      detail,
    });
  }
  return getEvent(eventId);
}

export const isRiskCategory = (v: string): v is RiskCategory =>
  (RISK_CATEGORIES as readonly string[]).includes(v);
