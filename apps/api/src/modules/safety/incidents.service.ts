import {
  INCIDENT_CATEGORY_LABELS,
  canIncidentTransition,
  describeIncidentStatus,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TRANSITIONS,
  type AdminIncidentDetail,
  type AdminIncidentRow,
  type IncidentBody,
  type IncidentCategory,
  type IncidentInfo,
  type IncidentNote,
  type IncidentNoteKind,
  type IncidentStatus,
  type TripRole,
} from '@yatri/types';

import { pool } from '../../config/database';
import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { requireParticipant } from '../trips/access';
import { notifySafetyTeam } from './safety-team';

/**
 * Incident reports about a ride. The reporter says what happened; the safety team reviews it, moves
 * it through the states in @yatri/types (the only table of legal moves), and keeps internal notes and
 * a record of the actions taken. Notes and actions are never shown to the reporter — they see the
 * status and are told when it changes.
 */
interface Row {
  id: string;
  trip_id: string;
  reporter_id: string;
  reporter_role: TripRole;
  category: IncidentCategory;
  description: string;
  status: IncidentStatus;
  created_at: Date;
  updated_at: Date;
}
const COLS =
  'id, trip_id, reporter_id, reporter_role, category, description, status, created_at, updated_at';

const toInfo = (r: Row): IncidentInfo => ({
  id: r.id,
  tripId: r.trip_id,
  category: r.category,
  description: r.description,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

// ---------------------------------------------------------------- the reporter

export async function createIncident(
  tripId: string,
  userId: string,
  body: IncidentBody,
): Promise<IncidentInfo> {
  const { trip, role } = await requireParticipant(tripId, userId);
  if (!trip.driver_id) {
    throw new HttpError(
      409,
      'INCIDENT_NOT_AVAILABLE',
      'You can report a problem with a ride once a driver has been assigned to it.',
    );
  }
  const r = await query<Row>(
    `INSERT INTO incident_reports (trip_id, reporter_id, reporter_role, category, description)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
    [tripId, userId, role, body.category, body.description],
  );
  const row = r.rows[0] as Row;
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: 'INCIDENT_CREATED',
    subjectType: 'incident',
    subjectIds: [row.id],
    detail: { category: body.category },
  });
  // The team is told that something needs review — the category, never the description.
  await notifySafetyTeam({
    type: 'INCIDENT_REPORTED',
    body: `A ${INCIDENT_CATEGORY_LABELS[body.category].toLowerCase()} report needs review.`,
    metadata: { incidentId: row.id, tripId },
  }).catch(() => undefined);
  return toInfo(row);
}

/** The reporter's own reports on this ride. */
export async function myIncidents(tripId: string, userId: string): Promise<IncidentInfo[]> {
  await requireParticipant(tripId, userId);
  const r = await query<Row>(
    `SELECT ${COLS} FROM incident_reports WHERE trip_id = $1 AND reporter_id = $2
     ORDER BY created_at DESC`,
    [tripId, userId],
  );
  return r.rows.map(toInfo);
}

// ---------------------------------------------------------------- the safety team

export async function listIncidents(opts: {
  status?: IncidentStatus;
  category?: IncidentCategory;
  page: number;
  pageSize: number;
}): Promise<{ items: AdminIncidentRow[]; total: number }> {
  const filter = [opts.status ?? null, opts.category ?? null];
  const where = `($1::text IS NULL OR i.status = $1) AND ($2::text IS NULL OR i.category = $2)`;
  const [rows, count] = await Promise.all([
    query<Row & { full_name: string | null }>(
      `SELECT i.*, u.full_name FROM incident_reports i JOIN users u ON u.id = i.reporter_id
       WHERE ${where}
       ORDER BY (i.status IN ('OPEN', 'UNDER_REVIEW')) DESC, i.created_at DESC
       LIMIT $3 OFFSET $4`,
      [...filter, opts.pageSize, (opts.page - 1) * opts.pageSize],
    ),
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM incident_reports i WHERE ${where}`,
      filter,
    ),
  ]);
  return {
    total: Number(count.rows[0]?.n ?? 0),
    items: rows.rows.map((r) => ({
      id: r.id,
      tripId: r.trip_id,
      category: r.category,
      status: r.status,
      reporterRole: r.reporter_role,
      reporterName: r.full_name,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

export async function incidentDetail(id: string): Promise<Omit<AdminIncidentDetail, 'audit'>> {
  const r = await query<Row & { full_name: string | null }>(
    'SELECT i.*, u.full_name FROM incident_reports i JOIN users u ON u.id = i.reporter_id WHERE i.id = $1',
    [id],
  );
  const i = r.rows[0];
  if (!i) throw new HttpError(404, 'NOT_FOUND', 'Report not found.');
  const notes = await query<{
    id: string;
    kind: IncidentNoteKind;
    body: string;
    from_status: IncidentStatus | null;
    to_status: IncidentStatus | null;
    full_name: string | null;
    created_at: Date;
  }>(
    `SELECT n.id, n.kind, n.body, n.from_status, n.to_status, n.created_at, u.full_name
     FROM incident_notes n LEFT JOIN users u ON u.id = n.admin_id
     WHERE n.incident_id = $1 ORDER BY n.created_at, n.id`,
    [id],
  );
  const timeline: IncidentNote[] = notes.rows.map((n) => ({
    id: n.id,
    kind: n.kind,
    body: n.body,
    fromStatus: n.from_status,
    toStatus: n.to_status,
    adminName: n.full_name,
    createdAt: n.created_at.toISOString(),
  }));
  return {
    id: i.id,
    tripId: i.trip_id,
    category: i.category,
    status: i.status,
    reporterRole: i.reporter_role,
    reporterName: i.full_name,
    createdAt: i.created_at.toISOString(),
    updatedAt: i.updated_at.toISOString(),
    description: i.description,
    notes: timeline,
  };
}

/**
 * Move a report to a new state. The table in @yatri/types decides what is legal; the row is locked so
 * two admins acting at once are applied one after the other, and the second sees the first's result.
 */
export async function changeIncidentStatus(
  id: string,
  adminId: string,
  to: IncidentStatus,
  note?: string,
): Promise<IncidentInfo> {
  const client = await pool.connect();
  let row: Row;
  let from: IncidentStatus;
  try {
    await client.query('BEGIN');
    const cur = await client.query<Row>(
      `SELECT ${COLS} FROM incident_reports WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const current = cur.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      throw new HttpError(404, 'NOT_FOUND', 'Report not found.');
    }
    from = current.status;
    if (!canIncidentTransition(from, to)) {
      await client.query('ROLLBACK');
      const next = INCIDENT_TRANSITIONS[from].map((x) => INCIDENT_STATUS_LABELS[x]);
      throw new HttpError(
        409,
        'INVALID_INCIDENT_TRANSITION',
        next.length === 0
          ? `This report is ${INCIDENT_STATUS_LABELS[from].toLowerCase()} and cannot change status.`
          : `A report that is ${INCIDENT_STATUS_LABELS[from].toLowerCase()} can only become: ${next.join(', ')}.`,
      );
    }
    const upd = await client.query<Row>(
      `UPDATE incident_reports SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
      [id, to],
    );
    row = upd.rows[0] as Row;
    await client.query(
      `INSERT INTO incident_notes (incident_id, admin_id, kind, body, from_status, to_status)
       VALUES ($1, $2, 'STATUS', $3, $4, $5)`,
      [id, adminId, note?.trim() || `Status changed from ${from} to ${to}.`, from, to],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'INCIDENT_STATUS_CHANGED',
    subjectType: 'incident',
    subjectIds: [id],
    detail: { from, to },
  });
  await notify({
    userId: row.reporter_id,
    type: 'INCIDENT_UPDATE',
    title: 'Yatri safety',
    body: describeIncidentStatus(row.category, row.status),
    metadata: { incidentId: id, tripId: row.trip_id },
  }).catch(() => undefined);
  return toInfo(row);
}

/** An internal note, or a record of an action taken. Never shown to the reporter. */
export async function addIncidentNote(
  id: string,
  adminId: string,
  kind: 'NOTE' | 'ACTION',
  body: string,
): Promise<void> {
  const exists = await query('SELECT 1 FROM incident_reports WHERE id = $1', [id]);
  if (!exists.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Report not found.');
  await query(
    'INSERT INTO incident_notes (incident_id, admin_id, kind, body) VALUES ($1, $2, $3, $4)',
    [id, adminId, kind, body],
  );
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: kind === 'ACTION' ? 'INCIDENT_ACTION_RECORDED' : 'INCIDENT_NOTE_ADDED',
    subjectType: 'incident',
    subjectIds: [id],
  });
}
