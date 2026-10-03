import { isoOrNull } from '../../lib/dates';
import {
  RISK_LEVELS,
  RISK_LEVEL_HELP,
  deriveRiskLevel,
  type AccountStatus,
  type RiskCategory,
  type RiskLevel,
  type RiskNoteInfo,
  type RiskOverview,
  type RiskTripDetail,
  type RiskUserDetail,
  type RiskUserRole,
  type RiskUserRow,
} from '@yatri/types';

import { auditTrail, recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { settingNumber } from '../settings/settings.service';
import { EVENT_SELECT, scoreFor, toEvent, type EventRow } from './events.service';
import { activeRestriction } from './restriction.service';

/**
 * What an administrator sees about a person or a ride: the signals, their score and level (always derived by
 * `deriveRiskLevel` from the events, the restriction and the account status), internal notes, and the complete
 * audit history. Reading one person or ride is itself audited. Nothing here carries a phone number, an address
 * or a coordinate: the rides and users screens, which audit their own reads, hold those.
 */
interface UniverseRow {
  id: string;
  full_name: string | null;
  role: RiskUserRole;
  status: AccountStatus;
  score: number;
  open_events: number;
  last_event_at: Date | null;
  restricted_until: Date | null;
}

/** Everyone with a signal that still counts, or an active restriction, with their derived level. */
async function riskUsers(): Promise<RiskUserRow[]> {
  const reviewScore = settingNumber('RISK_REVIEW_SCORE');
  const r = await query<UniverseRow>(
    `SELECT u.id, u.full_name, u.role, u.status,
            COALESCE(sum(e.points) FILTER (WHERE e.status IN ('OPEN', 'CONFIRMED')
                     AND e.created_at > now() - ($1::int * interval '1 day')), 0)::int AS score,
            count(e.id) FILTER (WHERE e.status = 'OPEN')::int AS open_events,
            max(e.created_at) AS last_event_at,
            CASE WHEN rp.restricted_until > now() THEN rp.restricted_until END AS restricted_until
     FROM users u
     LEFT JOIN risk_events e ON e.user_id = u.id
     LEFT JOIN risk_profiles rp ON rp.user_id = u.id
     WHERE e.id IS NOT NULL OR rp.restricted_until > now()
     GROUP BY u.id, rp.restricted_until`,
    [settingNumber('RISK_EVENT_WINDOW_DAYS')],
  );
  return r.rows.map((u) => ({
    userId: u.id,
    name: u.full_name,
    role: u.role,
    level: deriveRiskLevel({
      accountStatus: u.status,
      restrictedUntil: u.restricted_until,
      score: u.score,
      reviewScore,
    }),
    score: u.score,
    openEvents: u.open_events,
    lastEventAt: isoOrNull(u.last_event_at),
  }));
}

const SEVERITY = (l: RiskLevel) => RISK_LEVELS.indexOf(l);

export async function listRiskUsers(f: {
  level?: RiskLevel | undefined;
  search?: string | undefined;
  page: number;
  pageSize: number;
}): Promise<{ items: RiskUserRow[]; total: number }> {
  let rows = await riskUsers();
  if (f.level) rows = rows.filter((u) => u.level === f.level);
  if (f.search) {
    const needle = f.search.toLowerCase();
    rows = rows.filter(
      (u) => (u.name ?? '').toLowerCase().includes(needle) || u.userId === f.search,
    );
  }
  rows.sort((a, b) => SEVERITY(b.level) - SEVERITY(a.level) || b.score - a.score);
  return { total: rows.length, items: rows.slice((f.page - 1) * f.pageSize, f.page * f.pageSize) };
}

export async function riskOverview(): Promise<RiskOverview> {
  const users = await riskUsers();
  const [open, recent, byCat] = await Promise.all([
    query<{ n: number }>("SELECT count(*)::int AS n FROM risk_events WHERE status = 'OPEN'"),
    query<{ n: number }>(
      "SELECT count(*)::int AS n FROM risk_events WHERE created_at > now() - interval '24 hours'",
    ),
    query<{ category: RiskCategory; n: number }>(
      "SELECT category, count(*)::int AS n FROM risk_events WHERE status = 'OPEN' GROUP BY category ORDER BY n DESC",
    ),
  ]);
  const count = (l: RiskLevel) => users.filter((u) => u.level === l).length;
  return {
    reviewRequired: count('REVIEW_REQUIRED'),
    restricted: count('RESTRICTED'),
    suspended: count('SUSPENDED'),
    openEvents: open.rows[0]?.n ?? 0,
    eventsLast24h: recent.rows[0]?.n ?? 0,
    byCategory: byCat.rows.map((c) => ({ category: c.category, open: c.n })),
    reviewScore: settingNumber('RISK_REVIEW_SCORE'),
    autoRestrictScore: settingNumber('RISK_AUTO_RESTRICT_SCORE'),
  };
}

interface NoteRow {
  id: string;
  full_name: string | null;
  note: string;
  user_id: string | null;
  trip_id: string | null;
  event_id: string | null;
  created_at: Date;
}
const toNote = (n: NoteRow): RiskNoteInfo => ({
  id: n.id,
  authorName: n.full_name,
  note: n.note,
  userId: n.user_id,
  tripId: n.trip_id,
  eventId: n.event_id,
  createdAt: n.created_at.toISOString(),
});
const NOTE_SELECT = `SELECT n.id, a.full_name, n.note, n.user_id, n.trip_id, n.event_id, n.created_at
   FROM risk_notes n LEFT JOIN users a ON a.id = n.author_id`;

export async function userDetail(
  userId: string,
  adminId: string,
  can: { manageRisk: boolean; manageUsers: boolean },
): Promise<RiskUserDetail> {
  const u = (
    await query<{ full_name: string | null; role: RiskUserRole; status: AccountStatus }>(
      'SELECT full_name, role, status FROM users WHERE id = $1',
      [userId],
    )
  ).rows[0];
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'Person not found.');
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'RISK_USER_VIEWED',
    subjectType: 'risk_user',
    subjectIds: [userId],
  });
  const [events, notes, restriction, ctx] = await Promise.all([
    query<EventRow>(`${EVENT_SELECT} WHERE e.user_id = $1 ORDER BY e.created_at DESC LIMIT 100`, [
      userId,
    ]),
    query<NoteRow>(`${NOTE_SELECT} WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 100`, [
      userId,
    ]),
    activeRestriction(userId),
    query<{ completed: number; cancelled: number; disputes: number; refunds: number }>(
      `SELECT (SELECT count(*) FROM trips WHERE (passenger_id = $1 OR driver_id = $1) AND status = 'COMPLETED')::int AS completed,
              (SELECT count(*) FROM trips WHERE (passenger_id = $1 OR driver_id = $1) AND status = 'CANCELLED')::int AS cancelled,
              (SELECT count(*) FROM support_tickets WHERE requester_id = $1 AND is_dispute)::int AS disputes,
              (SELECT count(*) FROM refunds WHERE requested_by = $1)::int AS refunds`,
      [userId],
    ),
  ]);
  const { score } = await scoreFor(userId);
  const reviewScore = settingNumber('RISK_REVIEW_SCORE');
  const level = deriveRiskLevel({
    accountStatus: u.status,
    restrictedUntil: restriction?.until ?? null,
    score,
    reviewScore,
  });
  const notAdmin = u.role !== 'ADMIN';
  const c = ctx.rows[0];
  return {
    userId,
    name: u.full_name,
    role: u.role,
    accountStatus: u.status,
    level,
    levelHelp: RISK_LEVEL_HELP[level],
    score,
    reviewScore,
    maxRestrictionDays: settingNumber('RISK_MAX_RESTRICTION_DAYS'),
    restriction,
    events: events.rows.map(toEvent),
    notes: notes.rows.map(toNote),
    context: {
      completedRides: c?.completed ?? 0,
      cancelledRides: c?.cancelled ?? 0,
      disputes: c?.disputes ?? 0,
      refundRequests: c?.refunds ?? 0,
    },
    audit: await auditTrail(['risk_user', 'user'], userId),
    actions: {
      canRestrict: can.manageRisk && notAdmin && u.status === 'ACTIVE' && !restriction,
      canLift: can.manageRisk && !!restriction,
      canSuspend: can.manageUsers && notAdmin && u.status === 'ACTIVE',
      canRestore: can.manageUsers && notAdmin && u.status === 'SUSPENDED',
    },
  };
}

export async function tripDetail(tripId: string, adminId: string): Promise<RiskTripDetail> {
  const t = (
    await query<{
      status: string;
      passenger_id: string;
      passenger_name: string | null;
      driver_id: string | null;
      driver_name: string | null;
      has_payment: boolean;
      has_refund: boolean;
      has_dispute: boolean;
    }>(
      `SELECT t.status, t.passenger_id, p.full_name AS passenger_name, t.driver_id, d.full_name AS driver_name,
              EXISTS (SELECT 1 FROM trip_payments x WHERE x.trip_id = t.id) AS has_payment,
              EXISTS (SELECT 1 FROM refunds x WHERE x.trip_id = t.id) AS has_refund,
              EXISTS (SELECT 1 FROM support_tickets x WHERE x.trip_id = t.id AND x.is_dispute) AS has_dispute
       FROM trips t JOIN users p ON p.id = t.passenger_id LEFT JOIN users d ON d.id = t.driver_id
       WHERE t.id = $1`,
      [tripId],
    )
  ).rows[0];
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Ride not found.');
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'RISK_TRIP_VIEWED',
    subjectType: 'risk_trip',
    subjectIds: [tripId],
  });
  const [events, notes] = await Promise.all([
    query<EventRow>(`${EVENT_SELECT} WHERE e.trip_id = $1 ORDER BY e.created_at DESC LIMIT 100`, [
      tripId,
    ]),
    query<NoteRow>(`${NOTE_SELECT} WHERE n.trip_id = $1 ORDER BY n.created_at DESC LIMIT 100`, [
      tripId,
    ]),
  ]);
  return {
    tripId,
    status: t.status,
    passengerId: t.passenger_id,
    passengerName: t.passenger_name,
    driverId: t.driver_id,
    driverName: t.driver_name,
    events: events.rows.map(toEvent),
    notes: notes.rows.map(toNote),
    hasPayment: t.has_payment,
    hasRefund: t.has_refund,
    hasDispute: t.has_dispute,
    audit: await auditTrail('risk_trip', tripId),
  };
}

/** An internal note on a person, a ride or an event. The note is the administrator's; the audit says who and when. */
export async function addNote(
  adminId: string,
  target: { userId?: string | null; tripId?: string | null; eventId?: string | null },
  note: string,
): Promise<RiskNoteInfo> {
  let { userId = null, tripId = null } = target;
  const eventId = target.eventId ?? null;
  if (!userId && !tripId && !eventId) {
    throw new HttpError(400, 'NO_TARGET', 'Say whom, which ride or which event the note is about.');
  }
  if (eventId) {
    const e = (
      await query<{ user_id: string | null; trip_id: string | null }>(
        'SELECT user_id, trip_id FROM risk_events WHERE id = $1',
        [eventId],
      )
    ).rows[0];
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'Risk event not found.');
    userId ??= e.user_id;
    tripId ??= e.trip_id;
  }
  const missing =
    (userId && !(await query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount) ||
    (tripId && !(await query('SELECT 1 FROM trips WHERE id = $1', [tripId])).rowCount);
  if (missing) throw new HttpError(404, 'NOT_FOUND', 'Person or ride not found.');
  const r = await query<{ id: string }>(
    `INSERT INTO risk_notes (user_id, trip_id, event_id, author_id, note) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, tripId, eventId, adminId, note],
  );
  const id = r.rows[0]?.id as string;
  for (const s of [
    userId ? { type: 'risk_user', id: userId } : null,
    tripId ? { type: 'risk_trip', id: tripId } : null,
  ].filter((x): x is { type: string; id: string } => x !== null)) {
    // The note text lives in risk_notes; the audit entry says that one was added, not what it says.
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'RISK_NOTE_ADDED',
      subjectType: s.type,
      subjectIds: [s.id],
      detail: { noteId: id },
    });
  }
  const row = (await query<NoteRow>(`${NOTE_SELECT} WHERE n.id = $1`, [id])).rows[0] as NoteRow;
  return toNote(row);
}
