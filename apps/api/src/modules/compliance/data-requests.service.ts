import {
  ACTIVE_TRIP_STATUSES,
  DATA_REQUEST_STATUS_LABELS,
  DATA_REQUEST_TRANSITIONS,
  OPEN_DATA_REQUEST_STATES,
  canDataRequestTransition,
  describeDataRequest,
  type AdminDataRequestRow,
  type CreateDataRequestBody,
  type DataRequestActionBody,
  type DataRequestInfo,
  type DataRequestKind,
  type DataRequestStatus,
  type TripRole,
} from '@yatri/types';
import type { PoolClient } from 'pg';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { notify } from '../../lib/notifications';
import { sqlIn } from '../../lib/sql';
import { getStorageProvider } from '../../lib/storage/local-disk-provider';
import { HttpError } from '../../middleware/errorHandler';
import { revokeAllUserSessions } from '../auth/session.repository';
import { forceSuspend } from '../availability/availability.service';
import { settingNumber } from '../settings/settings.service';

/**
 * Account-deletion and personal-data-access requests. A request is a record with a lifecycle (the table in
 * @yatri/types) and a due date from the platform setting. Completing a deletion request anonymises the
 * person: it removes what identifies them and what is only theirs (profile, saved places, emergency
 * contacts, identity documents, sessions) and KEEPS what must be kept (rides, payments, refunds, support
 * and safety records, the audit log, compliance records), which then no longer point at a named person.
 * Retention periods are configuration (retention_policies), never decided here.
 */
interface Row {
  id: string;
  user_id: string;
  kind: DataRequestKind;
  status: DataRequestStatus;
  note: string | null;
  decision_note: string | null;
  due_at: Date;
  created_at: Date;
  completed_at: Date | null;
}
const COLS =
  'r.id, r.user_id, r.kind, r.status, r.note, r.decision_note, r.due_at, r.created_at, r.completed_at';

const toInfo = (r: Row): DataRequestInfo => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  statusText: describeDataRequest(r.kind, r.status),
  dueAt: r.due_at.toISOString(),
  decisionNote: r.decision_note,
  createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
  canDownload: r.kind === 'DATA_ACCESS' && r.status === 'COMPLETED',
  canCancel: canDataRequestTransition(r.status, 'CANCELLED'),
});

export async function createDataRequest(
  userId: string,
  role: TripRole,
  body: CreateDataRequestBody,
): Promise<DataRequestInfo> {
  try {
    const r = await query<Row>(
      `INSERT INTO data_requests (user_id, kind, note, due_at)
       VALUES ($1, $2, $3, now() + ($4::int * interval '1 day'))
       RETURNING id, user_id, kind, status, note, decision_note, due_at, created_at, completed_at`,
      [userId, body.kind, body.note?.trim() || null, settingNumber('DATA_REQUEST_RESPONSE_DAYS')],
    );
    const row = r.rows[0] as Row;
    await recordAudit({
      actorId: userId,
      actorRole: role,
      action: 'DATA_REQUEST_CREATED',
      subjectType: 'data_request',
      subjectIds: [row.id],
      detail: { kind: body.kind },
    });
    return toInfo(row);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(
        409,
        'REQUEST_ALREADY_OPEN',
        'You already have a request of this kind being handled.',
      );
    }
    throw err;
  }
}

export async function listMyDataRequests(userId: string): Promise<DataRequestInfo[]> {
  const r = await query<Row>(
    `SELECT ${COLS} FROM data_requests r WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [userId],
  );
  return r.rows.map(toInfo);
}

/** The person withdraws a request nobody has started on. */
export async function cancelMyDataRequest(userId: string, id: string): Promise<DataRequestInfo> {
  const row = await withTransaction(async (client) => {
    const cur = await client.query<Row>(
      `SELECT ${COLS} FROM data_requests r WHERE r.id = $1 AND r.user_id = $2 FOR UPDATE`,
      [id, userId],
    );
    const current = cur.rows[0];
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'Request not found.');
    if (!canDataRequestTransition(current.status, 'CANCELLED')) {
      throw new HttpError(
        409,
        'CANNOT_CANCEL',
        'Someone has already started on this request, so it can no longer be withdrawn.',
      );
    }
    const upd = await client.query<Row>(
      `UPDATE data_requests r SET status = 'CANCELLED', updated_at = now() WHERE r.id = $1 RETURNING ${COLS}`,
      [id],
    );
    return upd.rows[0] as Row;
  });
  return toInfo(row);
}

// ---------------------------------------------------------------- the administrator's queue

const OPEN = sqlIn(OPEN_DATA_REQUEST_STATES);

export interface AdminDataRequestFilters {
  status?: DataRequestStatus;
  kind?: DataRequestKind;
  open?: boolean;
  page: number;
  pageSize: number;
}

export async function listAdminDataRequests(
  f: AdminDataRequestFilters,
): Promise<{ items: AdminDataRequestRow[]; total: number }> {
  const where = `WHERE ($1::text IS NULL OR r.status = $1) AND ($2::text IS NULL OR r.kind = $2)
    AND ($3::boolean IS NOT TRUE OR r.status IN ${OPEN})`;
  const params = [f.status ?? null, f.kind ?? null, f.open ?? null];
  const [rows, count] = await Promise.all([
    query<Row & { full_name: string | null; role: TripRole; decider: string | null }>(
      `SELECT ${COLS}, u.full_name, u.role, d.full_name AS decider
       FROM data_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by
       ${where} ORDER BY (r.status IN ${OPEN}) DESC, r.due_at ASC, r.id LIMIT $4 OFFSET $5`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    ),
    query<{ n: string }>(`SELECT count(*)::text AS n FROM data_requests r ${where}`, params),
  ]);
  return {
    total: Number(count.rows[0]?.n ?? 0),
    items: rows.rows.map((r) => ({
      ...toInfo(r),
      userId: r.user_id,
      userName: r.full_name,
      userRole: r.role,
      note: r.note,
      decidedByName: r.decider,
      overdue: OPEN_DATA_REQUEST_STATES.includes(r.status) && r.due_at.getTime() < Date.now(),
      allowedNext: [...DATA_REQUEST_TRANSITIONS[r.status]].filter((s) => s !== 'CANCELLED'),
    })),
  };
}

/** What stops an account being deleted right now (an honest list; empty means it can go ahead). */
export async function deletionBlockers(userId: string): Promise<string[]> {
  const blockers: string[] = [];
  const trip = await query(
    `SELECT 1 FROM trips WHERE (passenger_id = $1 OR driver_id = $1) AND status IN ${sqlIn(ACTIVE_TRIP_STATUSES)} LIMIT 1`,
    [userId],
  );
  if (trip.rowCount) blockers.push('a ride is still under way');
  const pay = await query(
    `SELECT 1 FROM trip_payments p JOIN trips t ON t.id = p.trip_id
     WHERE (t.passenger_id = $1 OR t.driver_id = $1) AND p.status = 'PENDING'
       AND NOT (p.method = 'ORGANIZATION' AND t.passenger_id = $1) LIMIT 1`,
    [userId],
  );
  if (pay.rowCount) blockers.push('a ride has a payment that is not settled yet');
  const refund = await query(
    `SELECT 1 FROM refunds f JOIN trips t ON t.id = f.trip_id
     WHERE (t.passenger_id = $1 OR t.driver_id = $1) AND f.status NOT IN ('COMPLETED', 'REJECTED') LIMIT 1`,
    [userId],
  );
  if (refund.rowCount) blockers.push('a refund is still being handled');
  // An organization must not be left without an owner by one person leaving.
  const sole = await query(
    `SELECT 1 FROM organization_members m
     WHERE m.user_id = $1 AND m.role = 'OWNER' AND m.status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM organization_members o
                       WHERE o.organization_id = m.organization_id AND o.role = 'OWNER'
                         AND o.status = 'ACTIVE' AND o.user_id <> $1) LIMIT 1`,
    [userId],
  );
  if (sole.rowCount)
    blockers.push('you are the only owner of an organization: make someone else an owner first');
  return blockers;
}

/** Remove what identifies the person and what is only theirs; return the stored files to delete afterwards. */
async function anonymise(client: PoolClient, userId: string): Promise<string[]> {
  const docs = await client.query<{ storage_key: string }>(
    `DELETE FROM documents WHERE driver_user_id = $1
        OR vehicle_id IN (SELECT id FROM vehicles WHERE driver_user_id = $1) RETURNING storage_key`,
    [userId],
  );
  await client.query('DELETE FROM saved_places WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM user_preferences WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM passenger_accessibility WHERE user_id = $1', [userId]);
  await client.query(
    'DELETE FROM trip_accessibility WHERE trip_id IN (SELECT id FROM trips WHERE passenger_id = $1)',
    [userId],
  );
  await client.query('DELETE FROM emergency_contacts WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM driver_details WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM driver_last_locations WHERE driver_id = $1', [userId]);
  // The account stays as a row (rides and payments point at it) but names nobody and cannot sign in.
  await client.query(
    `UPDATE users SET full_name = 'Deleted account', phone_number = NULL, email = NULL,
       profile_picture_url = NULL, password_hash = NULL, status = 'DEACTIVATED', updated_at = now()
     WHERE id = $1`,
    [userId],
  );
  return docs.rows.map((d) => d.storage_key);
}

/** Move a request along. Completing a deletion does the deletion; it is refused while something blocks it. */
export async function actOnDataRequest(
  adminId: string,
  id: string,
  body: DataRequestActionBody,
): Promise<DataRequestInfo> {
  const to = body.to;
  const { row, from, keys } = await withTransaction(async (client) => {
    const cur = await client.query<Row>(
      `SELECT ${COLS} FROM data_requests r WHERE r.id = $1 FOR UPDATE`,
      [id],
    );
    const current = cur.rows[0];
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'Request not found.');
    // A person withdraws their own request; an administrator only moves it forward or declines it.
    if (to === 'CANCELLED' || !canDataRequestTransition(current.status, to)) {
      const next = DATA_REQUEST_TRANSITIONS[current.status]
        .filter((s) => s !== 'CANCELLED')
        .map((s) => DATA_REQUEST_STATUS_LABELS[s]);
      throw new HttpError(
        409,
        'INVALID_REQUEST_TRANSITION',
        next.length === 0
          ? `This request is ${DATA_REQUEST_STATUS_LABELS[current.status].toLowerCase()} and cannot change.`
          : `A request that is ${DATA_REQUEST_STATUS_LABELS[current.status].toLowerCase()} can only become: ${next.join(', ')}.`,
      );
    }
    if (to === 'REJECTED' && !body.note?.trim()) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'Say why the request cannot be done.',
      ).withDetails({
        note: ['Required'],
      });
    }
    let keys: string[] = [];
    if (to === 'COMPLETED' && current.kind === 'ACCOUNT_DELETION') {
      const blockers = await deletionBlockers(current.user_id);
      if (blockers.length > 0) {
        throw new HttpError(
          409,
          'DELETION_BLOCKED',
          `This account cannot be deleted yet: ${blockers.join('; ')}.`,
        );
      }
      keys = await anonymise(client, current.user_id);
    }
    const upd = await client.query<Row>(
      `UPDATE data_requests r SET status = $2, updated_at = now(), decided_by = $3,
         decision_note = COALESCE($4, decision_note),
         completed_at = CASE WHEN $2 IN ('COMPLETED', 'REJECTED') THEN now() ELSE completed_at END
       WHERE r.id = $1 RETURNING ${COLS}`,
      [id, to, adminId, body.note?.trim() || null],
    );
    return { row: upd.rows[0] as Row, from: current.status, keys };
  });
  // After the commit: files and sessions. A failure here leaves the account already anonymised.
  if (row.kind === 'ACCOUNT_DELETION' && to === 'COMPLETED') {
    await revokeAllUserSessions(row.user_id);
    await forceSuspend(row.user_id, adminId, 'ACCOUNT_DELETED').catch(() => undefined);
    for (const key of keys)
      await getStorageProvider()
        .delete(key)
        .catch(() => undefined);
  }
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'DATA_REQUEST_STATUS_CHANGED',
    subjectType: 'data_request',
    subjectIds: [id],
    detail: { kind: row.kind, from, to },
  });
  // A deleted account has nobody left to tell (its notifications were removed with it).
  if (!(row.kind === 'ACCOUNT_DELETION' && to === 'COMPLETED')) {
    await notify({
      userId: row.user_id,
      type: 'DATA_REQUEST_UPDATE',
      title: 'Yatri privacy',
      body: describeDataRequest(row.kind, row.status),
      metadata: { requestId: id },
    }).catch(() => undefined);
  }
  return toInfo(row);
}

// ---------------------------------------------------------------- the copy of a person's data

/**
 * The personal-data copy for a completed DATA_ACCESS request: what Yatri holds about this person, as JSON.
 * Other people's details are not in it (a ride names only the place and the person's own side of it), and
 * internal notes and the audit log are not the person's data to receive. Built when downloaded, so it is
 * current, never stored as a second copy. Every download is written to the audit log.
 */
export async function buildPersonalDataExport(userId: string, role: TripRole, requestId: string) {
  const req = await query<{ kind: string; status: string }>(
    'SELECT kind, status FROM data_requests WHERE id = $1 AND user_id = $2',
    [requestId, userId],
  );
  const r = req.rows[0];
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Request not found.');
  if (r.kind !== 'DATA_ACCESS' || r.status !== 'COMPLETED') {
    throw new HttpError(409, 'NOT_READY', 'Your copy is not ready yet.');
  }
  const [
    profile,
    driver,
    places,
    contacts,
    trips,
    ratings,
    tickets,
    refunds,
    policies,
    requests,
    notes,
    prefs,
    accessibility,
  ] = await Promise.all([
    query(
      `SELECT id, role, status, phone_number, email, full_name, created_at FROM users WHERE id = $1`,
      [userId],
    ),
    query(
      `SELECT full_legal_name, date_of_birth, license_number, license_expiry_date, city
         FROM driver_details WHERE user_id = $1`,
      [userId],
    ),
    query(`SELECT kind, name, label, created_at FROM saved_places WHERE user_id = $1`, [userId]),
    query(`SELECT name, phone_number, created_at FROM emergency_contacts WHERE user_id = $1`, [
      userId,
    ]),
    query(
      `SELECT t.id, CASE WHEN t.passenger_id = $1 THEN 'PASSENGER' ELSE 'DRIVER' END AS your_role, t.status,
                t.requested_at, t.ended_at, pl.address AS pickup, dl.address AS destination,
                t.fare_final_npr, t.waiting_charge_npr, t.cancellation_fee_npr, p.status AS payment_status
         FROM trips t JOIN locations pl ON pl.id = t.pickup_location_id JOIN locations dl ON dl.id = t.destination_location_id
         LEFT JOIN trip_payments p ON p.trip_id = t.id
         WHERE t.passenger_id = $1 OR t.driver_id = $1 ORDER BY t.requested_at DESC LIMIT 1000`,
      [userId],
    ),
    query(
      `SELECT trip_id, rater_role, stars, comment, created_at FROM trip_ratings WHERE rater_id = $1`,
      [userId],
    ),
    query(
      `SELECT t.number, t.subject, t.status, t.created_at,
                (SELECT json_agg(json_build_object('from', m.author_kind, 'body', m.body, 'at', m.created_at) ORDER BY m.created_at)
                 FROM support_messages m WHERE m.ticket_id = t.id AND m.kind <> 'NOTE') AS messages
         FROM support_tickets t WHERE t.requester_id = $1 ORDER BY t.created_at`,
      [userId],
    ),
    query(
      `SELECT f.amount_npr, f.reason, f.status, f.created_at FROM refunds f
         JOIN support_tickets t ON t.id = f.ticket_id WHERE t.requester_id = $1`,
      [userId],
    ),
    query(
      `SELECT policy_key, policy_version, accepted_at FROM compliance_records WHERE user_id = $1 ORDER BY accepted_at`,
      [userId],
    ),
    query(`SELECT kind, status, created_at, completed_at FROM data_requests WHERE user_id = $1`, [
      userId,
    ]),
    query(
      `SELECT type, title, body, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [userId],
    ),
    query(`SELECT choices, updated_at FROM user_preferences WHERE user_id = $1`, [userId]),
    query(
      `SELECT needs, communication, pickup_instructions, pickup_note, other_note, updated_at
         FROM passenger_accessibility WHERE user_id = $1`,
      [userId],
    ),
  ]);
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: 'DATA_EXPORT_DOWNLOADED',
    subjectType: 'data_request',
    subjectIds: [requestId],
  });
  return {
    generatedAt: new Date().toISOString(),
    profile: profile.rows[0] ?? null,
    driverDetails: driver.rows[0] ?? null,
    savedPlaces: places.rows,
    emergencyContacts: contacts.rows,
    rides: trips.rows,
    ratingsYouGave: ratings.rows,
    supportRequests: tickets.rows,
    refunds: refunds.rows,
    policyAcceptances: policies.rows,
    privacyRequests: requests.rows,
    recentNotifications: notes.rows,
    settings: prefs.rows[0] ?? null,
    accessibility: accessibility.rows[0] ?? null,
  };
}
