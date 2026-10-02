import {
  AWAITING_SUPPORT_STATES,
  REQUESTER_CAN_CLOSE_FROM,
  SUPPORT_NOTIFICATION_TYPES,
  TICKET_STATUS_LABELS,
  TICKET_TRANSITIONS,
  canTicketTransition,
  describeTicketStatus,
  statusAfterReply,
  type AdminNoteBody,
  type AdminReplyBody,
  type AdminStatusBody,
  type AdminTicketDetail,
  type AdminTicketMessage,
  type AdminTicketRow,
  type AttachmentInfo,
  type CreateTicketBody,
  type TicketDetail,
  type TicketInfo,
  type TicketMessageInfo,
  type TicketOutcome,
  type TicketStatus,
  type TripRole,
} from '@yatri/types';
import type { PoolClient } from 'pg';

import { env } from '../../config/env';
import { recordAudit, auditTrail } from '../../lib/audit';
import { detectFileType } from '../../lib/file-signature';
import { log } from '../../lib/logger';
import { query, withTransaction } from '../../lib/db';
import { generateStorageKey, sanitizeDisplayFilename } from '../../lib/safe-filename';
import { getStorageProvider } from '../../lib/storage';
import { HttpError } from '../../middleware/errorHandler';
import { likeContains } from '../admin/admin-range';
import { hasPermission } from '../admin/permissions';
import { settingNumber } from '../settings/settings.service';
import { requireParticipant } from '../trips/access';
import { getTrip } from '../trips/trips.repository';
import { getCategory } from './support.config';
import { notifyRequester, notifySupportTeam } from './support-notify';
import {
  adminRefundsForTicket,
  paymentContext,
  refundViewForRequester,
  ticketHasActiveRefund,
} from './refunds.service';
import { sqlIn } from '../../lib/sql';

/**
 * Support tickets: ONE record and ONE lifecycle for a question, a problem or a ride dispute. A dispute is
 * a ticket whose category is of kind DISPUTE; it points at the ride (trip_id) and copies nothing from it.
 *
 * The states and their legal moves are the tables in @yatri/types. Every change goes through a guarded
 * update inside a transaction with the row locked, so two people (or a person and a sweep) acting at the
 * same moment cannot both apply a move that is only legal from one state.
 */
export interface UploadedFile {
  buffer: Buffer;
  size: number;
  originalname: string;
}

interface TicketRow {
  id: string;
  number: string;
  requester_id: string;
  requester_role: TripRole;
  category_code: string;
  category_label: string;
  is_dispute: boolean;
  subject: string;
  status: TicketStatus;
  priority: string;
  assigned_to: string | null;
  trip_id: string | null;
  outcome: TicketOutcome | null;
  resolution_note: string | null;
  escalation_level: number;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}
const TICKET_COLS = `t.id, t.number::text, t.requester_id, t.requester_role, t.category_code, c.label AS category_label,
  t.is_dispute, t.subject, t.status, t.priority, t.assigned_to, t.trip_id, t.outcome, t.resolution_note,
  t.escalation_level, t.created_at, t.updated_at, t.resolved_at`;
const TICKET_FROM = `support_tickets t JOIN support_categories c ON c.code = t.category_code`;

const toInfo = (r: TicketRow): TicketInfo => ({
  id: r.id,
  number: Number(r.number),
  categoryCode: r.category_code,
  categoryLabel: r.category_label,
  isDispute: r.is_dispute,
  subject: r.subject,
  status: r.status,
  statusText: describeTicketStatus(Number(r.number), r.status),
  tripId: r.trip_id,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  // A reopened ticket has no decision until it is decided again.
  outcome: r.resolved_at ? r.outcome : null,
  resolution: r.resolved_at ? r.resolution_note : null,
});

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Ticket not found.');

// ---------------------------------------------------------------- shared pieces

async function insertMessage(
  client: PoolClient,
  ticketId: string,
  authorId: string | null,
  authorKind: 'REQUESTER' | 'ADMIN' | 'SYSTEM',
  kind: 'MESSAGE' | 'NOTE' | 'STATUS' | 'RESOLUTION',
  body: string,
): Promise<string> {
  // clock_timestamp(): two messages in one transaction keep their real order.
  const r = await client.query<{ id: string }>(
    `INSERT INTO support_messages (ticket_id, author_id, author_kind, kind, body, created_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp()) RETURNING id`,
    [ticketId, authorId, authorKind, kind, body],
  );
  return (r.rows[0] as { id: string }).id;
}

/** Check a file before anything is stored: size and what the bytes really are (never the name or header). */
function checkFile(file: UploadedFile) {
  if (file.size > env.MAX_UPLOAD_FILE_SIZE_BYTES) {
    throw new HttpError(413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size.');
  }
  const detected = detectFileType(file.buffer);
  if (!detected) {
    throw new HttpError(400, 'INVALID_FILE_TYPE', 'Only JPEG, PNG, or PDF files are accepted.');
  }
  return detected;
}

async function attachmentCount(client: PoolClient, ticketId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM support_attachments WHERE ticket_id = $1',
    [ticketId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function loadAttachments(ticketId: string): Promise<Map<string, AttachmentInfo[]>> {
  const r = await query<{
    id: string;
    message_id: string | null;
    filename: string;
    content_type: string;
    size_bytes: number;
    created_at: Date;
  }>(
    `SELECT id, message_id, filename, content_type, size_bytes, created_at
     FROM support_attachments WHERE ticket_id = $1 ORDER BY created_at`,
    [ticketId],
  );
  const map = new Map<string, AttachmentInfo[]>();
  for (const a of r.rows) {
    if (!a.message_id) continue;
    const list = map.get(a.message_id) ?? [];
    list.push({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
      createdAt: a.created_at.toISOString(),
    });
    map.set(a.message_id, list);
  }
  return map;
}

/**
 * Store a file with a message: bytes go to the one private store (never public, never keyed by the
 * person's filename), the row is inserted in the caller's transaction. Returns the storage key so the
 * caller can remove the object if the transaction later fails.
 */
async function storeAttachment(
  client: PoolClient,
  ticketId: string,
  messageId: string,
  uploaderId: string,
  file: UploadedFile,
  detected: ReturnType<typeof checkFile>,
  key: string,
): Promise<void> {
  const cap = settingNumber('SUPPORT_MAX_ATTACHMENTS_PER_TICKET');
  if ((await attachmentCount(client, ticketId)) >= cap) {
    throw new HttpError(409, 'TOO_MANY_ATTACHMENTS', `A request can hold at most ${cap} files.`);
  }
  await client.query(
    `INSERT INTO support_attachments (ticket_id, message_id, uploader_id, storage_key, filename, content_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ticketId,
      messageId,
      uploaderId,
      key,
      sanitizeDisplayFilename(file.originalname),
      detected.mimeType,
      file.size,
    ],
  );
}

/**
 * Put a message on a ticket (with an optional file) inside `apply`, which does the ticket-specific
 * checks and status change. The object is stored before the transaction and removed again if it fails,
 * so a refused reply never leaves an orphan file.
 */
async function withOptionalFile<T>(
  ticketId: string,
  file: UploadedFile | undefined,
  work: (
    client: PoolClient,
    attach: (messageId: string, uploaderId: string) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const detected = file ? checkFile(file) : null;
  const key =
    file && detected ? generateStorageKey(`support/${ticketId}`, detected.extension) : null;
  let stored = false;
  try {
    return await withTransaction(async (client) =>
      work(client, async (messageId, uploaderId) => {
        if (!file || !detected || !key) return;
        await storeAttachment(client, ticketId, messageId, uploaderId, file, detected, key);
        await getStorageProvider().upload({
          key,
          buffer: file.buffer,
          contentType: detected.mimeType,
        });
        stored = true;
      }),
    );
  } catch (err) {
    if (stored && key)
      await getStorageProvider()
        .delete(key)
        .catch(() => undefined);
    throw err;
  }
}

function attachedText(file: UploadedFile): string {
  return `Attached a file: ${sanitizeDisplayFilename(file.originalname)}`;
}

// ---------------------------------------------------------------- the person's side

export async function createTicket(
  userId: string,
  role: TripRole,
  body: CreateTicketBody,
): Promise<TicketInfo> {
  const category = await getCategory(body.categoryCode);
  if (!category || !category.isActive || !category.forRoles.includes(role)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a category from the list.').withDetails({
      categoryCode: ['Choose a category from the list'],
    });
  }
  let tripId: string | null = null;
  if (category.requiresRide && !body.tripId) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Choose the ride this is about.').withDetails({
      tripId: ['Choose the ride this is about'],
    });
  }
  if (body.tripId) {
    // The ride is referenced, and only by someone who was on it (strangers get the same 404 as a missing ride).
    const { trip, role: rideRole } = await requireParticipant(body.tripId, userId);
    if (rideRole !== role) throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
    if (
      category.kind === 'DISPUTE' &&
      (trip.status === 'SEARCHING' || trip.status === 'NO_DRIVERS')
    ) {
      throw new HttpError(
        409,
        'NOTHING_TO_DISPUTE',
        'There is no ride to report a problem with yet.',
      );
    }
    tripId = trip.id;
  }
  const isDispute = category.kind === 'DISPUTE';

  const created = await withTransaction(async (client) => {
    let row: { id: string; number: string };
    try {
      const r = await client.query<{ id: string; number: string }>(
        `INSERT INTO support_tickets (requester_id, requester_role, category_code, is_dispute, subject, priority, trip_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, number::text`,
        [userId, role, category.code, isDispute, body.subject, category.defaultPriority, tripId],
      );
      row = r.rows[0] as { id: string; number: string };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(
          409,
          'DISPUTE_ALREADY_OPEN',
          'You already have an open problem report for this ride.',
        );
      }
      throw err;
    }
    await insertMessage(client, row.id, userId, 'REQUESTER', 'MESSAGE', body.body);
    return row;
  });
  const info = await getTicketInfo(created.id);
  await notifyRequester(
    userId,
    SUPPORT_NOTIFICATION_TYPES.TICKET_CREATED,
    describeTicketStatus(info.number, 'OPEN'),
    { ticketId: info.id },
  );
  await notifySupportTeam({
    type: SUPPORT_NOTIFICATION_TYPES.TICKET_CREATED,
    body: `New support request ${info.number} needs a look.`,
    ticketId: info.id,
  });
  return info;
}

async function getTicketInfo(id: string): Promise<TicketInfo> {
  const r = await query<TicketRow>(`SELECT ${TICKET_COLS} FROM ${TICKET_FROM} WHERE t.id = $1`, [
    id,
  ]);
  if (!r.rows[0]) throw notFound();
  return toInfo(r.rows[0]);
}

export async function listMyTickets(
  userId: string,
  filter: { tripId?: string } = {},
): Promise<TicketInfo[]> {
  const r = await query<TicketRow>(
    `SELECT ${TICKET_COLS} FROM ${TICKET_FROM}
     WHERE t.requester_id = $1 AND ($2::uuid IS NULL OR t.trip_id = $2)
     ORDER BY t.updated_at DESC, t.id LIMIT 100`,
    [userId, filter.tripId ?? null],
  );
  return r.rows.map(toInfo);
}

export async function getMyTicket(userId: string, id: string): Promise<TicketDetail> {
  const r = await query<TicketRow>(
    `SELECT ${TICKET_COLS} FROM ${TICKET_FROM} WHERE t.id = $1 AND t.requester_id = $2`,
    [id, userId],
  );
  const row = r.rows[0];
  if (!row) throw notFound();
  const [msgs, attachments, refundView] = await Promise.all([
    query<{
      id: string;
      author_kind: 'REQUESTER' | 'ADMIN' | 'SYSTEM';
      body: string;
      created_at: Date;
    }>(
      // Internal notes are never part of what the person sees.
      `SELECT id, author_kind, body, created_at FROM support_messages
       WHERE ticket_id = $1 AND kind <> 'NOTE' ORDER BY created_at, id`,
      [id],
    ),
    loadAttachments(id),
    refundViewForRequester(row),
  ]);
  const cap = settingNumber('SUPPORT_MAX_ATTACHMENTS_PER_TICKET');
  const used = [...attachments.values()].reduce((n, l) => n + l.length, 0);
  const messages: TicketMessageInfo[] = msgs.rows.map((m) => ({
    id: m.id,
    from: m.author_kind === 'REQUESTER' ? 'YOU' : m.author_kind === 'ADMIN' ? 'SUPPORT' : 'SYSTEM',
    body: m.body,
    createdAt: m.created_at.toISOString(),
    attachments: attachments.get(m.id) ?? [],
  }));
  return {
    ...toInfo(row),
    messages,
    canReply: row.status !== 'CLOSED',
    canClose: REQUESTER_CAN_CLOSE_FROM.includes(row.status),
    attachmentsLeft: Math.max(0, cap - used),
    refund: refundView.refund,
    canRequestRefund: refundView.canRequestRefund,
  };
}

/** A person's reply (optionally with a file). It hands the ticket to us, and reopens a resolved one. */
export async function replyAsRequester(
  userId: string,
  ticketId: string,
  text: string | null,
  file?: UploadedFile,
): Promise<TicketDetail> {
  if (!text && !file) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Write a message or choose a file.');
  }
  const result = await withOptionalFile(ticketId, file, async (client, attach) => {
    const cur = await client.query<{
      id: string;
      number: string;
      status: TicketStatus;
      requester_id: string;
      assigned_to: string | null;
    }>(
      `SELECT id, number::text, status, requester_id, assigned_to FROM support_tickets WHERE id = $1 FOR UPDATE`,
      [ticketId],
    );
    const t = cur.rows[0];
    if (!t || t.requester_id !== userId) throw notFound();
    const next = statusAfterReply(t.status, 'REQUESTER');
    if (next === null) {
      throw new HttpError(
        409,
        'TICKET_CLOSED',
        'This request is closed. Start a new one if you still need help.',
      );
    }
    const messageId = await insertMessage(
      client,
      t.id,
      userId,
      'REQUESTER',
      'MESSAGE',
      text ?? attachedText(file as UploadedFile),
    );
    await attach(messageId, userId);
    await client.query(
      `UPDATE support_tickets SET status = $2, updated_at = now(),
         resolved_at = CASE WHEN status = 'RESOLVED' THEN NULL ELSE resolved_at END
       WHERE id = $1`,
      [t.id, next],
    );
    return { number: Number(t.number), assignedTo: t.assigned_to };
  });
  await notifySupportTeam({
    type: SUPPORT_NOTIFICATION_TYPES.REPLY,
    body: `Support request ${result.number} has a new reply.`,
    ticketId,
    assignedTo: result.assignedTo,
  });
  return getMyTicket(userId, ticketId);
}

/** The person closes a request that has been resolved. Nothing else may be closed by them. */
export async function closeAsRequester(userId: string, ticketId: string): Promise<TicketDetail> {
  await withTransaction(async (client) => {
    const cur = await client.query<{ id: string; status: TicketStatus; requester_id: string }>(
      `SELECT id, status, requester_id FROM support_tickets WHERE id = $1 FOR UPDATE`,
      [ticketId],
    );
    const t = cur.rows[0];
    if (!t || t.requester_id !== userId) throw notFound();
    if (!REQUESTER_CAN_CLOSE_FROM.includes(t.status) || !canTicketTransition(t.status, 'CLOSED')) {
      throw new HttpError(
        409,
        'CANNOT_CLOSE',
        t.status === 'CLOSED'
          ? 'This request is already closed.'
          : 'You can close a request once it is resolved.',
      );
    }
    await client.query(
      `UPDATE support_tickets SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE id = $1`,
      [ticketId],
    );
    await insertMessage(client, ticketId, userId, 'SYSTEM', 'STATUS', 'You closed this request.');
  });
  return getMyTicket(userId, ticketId);
}

/** The signed, short-lived address of one attachment, for the person the ticket belongs to. */
export async function requesterAttachment(userId: string, attachmentId: string) {
  const r = await query<{ storage_key: string; content_type: string; filename: string }>(
    `SELECT a.storage_key, a.content_type, a.filename FROM support_attachments a
     JOIN support_tickets t ON t.id = a.ticket_id WHERE a.id = $1 AND t.requester_id = $2`,
    [attachmentId, userId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'File not found.');
  return signedUrl(r.rows[0]);
}

async function signedUrl(a: { storage_key: string; content_type: string; filename: string }) {
  const url = await getStorageProvider().createTemporaryAccessUrl(
    a.storage_key,
    env.STORAGE_SIGNED_URL_TTL_SECONDS,
    { contentType: a.content_type, filename: a.filename },
  );
  return { url, expiresInSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS };
}

// ---------------------------------------------------------------- the admin's side

/**
 * What an administrator may see: everything with SUPPORT_MANAGE, ride problems only with DISPUTES_MANAGE.
 * (The routes need DISPUTES_MANAGE at least; this narrows the ticket set for those who hold no more.)
 */
async function canSeeGeneral(adminId: string): Promise<boolean> {
  return hasPermission(adminId, 'SUPPORT_MANAGE');
}

export interface AdminTicketFilters {
  status?: TicketStatus;
  /** open = not resolved or closed; awaiting = waiting on us. */
  group?: 'open' | 'awaiting' | 'finished';
  priority?: string;
  category?: string;
  kind?: 'dispute' | 'general';
  assigned?: 'me' | 'none' | string;
  overdue?: boolean;
  tripId?: string;
  requesterId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

const OPEN_SQL = sqlIn(['OPEN', 'IN_REVIEW', 'WAITING_FOR_USER', 'WAITING_FOR_ADMIN']);
const AWAITING_SQL = sqlIn(AWAITING_SUPPORT_STATES);

type AdminRow = TicketRow & {
  requester_name: string | null;
  assigned_name: string | null;
  priority_label: string;
  priority_rank: number;
  due_at: Date | null;
};

const ADMIN_SELECT = `${TICKET_COLS}, u.full_name AS requester_name, a.full_name AS assigned_name,
  p.label AS priority_label, p.rank AS priority_rank,
  CASE WHEN t.status IN ${AWAITING_SQL} THEN t.updated_at + p.first_response_hours * interval '1 hour' END AS due_at`;
const ADMIN_FROM = `${TICKET_FROM}
  JOIN support_priorities p ON p.code = t.priority
  JOIN users u ON u.id = t.requester_id
  LEFT JOIN users a ON a.id = t.assigned_to`;

const toAdminRow = (r: AdminRow): AdminTicketRow => ({
  id: r.id,
  number: Number(r.number),
  subject: r.subject,
  categoryCode: r.category_code,
  categoryLabel: r.category_label,
  isDispute: r.is_dispute,
  status: r.status,
  priorityCode: r.priority,
  priorityLabel: r.priority_label,
  priorityRank: r.priority_rank,
  requesterId: r.requester_id,
  requesterName: r.requester_name,
  requesterRole: r.requester_role,
  assignedToId: r.assigned_to,
  assignedToName: r.assigned_name,
  tripId: r.trip_id,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  escalationLevel: r.escalation_level,
  responseDueAt: r.due_at?.toISOString() ?? null,
  overdue: !!r.due_at && r.due_at.getTime() < Date.now(),
});

export async function listAdminTickets(
  adminId: string,
  f: AdminTicketFilters,
): Promise<{ items: AdminTicketRow[]; total: number }> {
  const general = await canSeeGeneral(adminId);
  const where = `
    WHERE ($1::text IS NULL OR t.status = $1)
      AND ($2::text IS NULL OR ($2 = 'open' AND t.status IN ${OPEN_SQL})
           OR ($2 = 'awaiting' AND t.status IN ${AWAITING_SQL})
           OR ($2 = 'finished' AND t.status IN ('RESOLVED', 'CLOSED')))
      AND ($3::text IS NULL OR t.priority = $3)
      AND ($4::text IS NULL OR t.category_code = $4)
      AND ($5::text IS NULL OR ($5 = 'dispute') = t.is_dispute)
      AND ($6::text IS NULL OR ($6 = 'none' AND t.assigned_to IS NULL) OR ($6 = 'me' AND t.assigned_to = $12)
           OR t.assigned_to::text = $6)
      AND ($7::boolean IS NOT TRUE OR (t.status IN ${AWAITING_SQL}
           AND t.updated_at + p.first_response_hours * interval '1 hour' < now()))
      AND ($8::uuid IS NULL OR t.trip_id = $8)
      AND ($9::uuid IS NULL OR t.requester_id = $9)
      AND (($10::text IS NULL AND $11::text IS NULL) OR t.number::text = $10
           OR t.subject ILIKE $11 ESCAPE '!' OR u.full_name ILIKE $11 ESCAPE '!'
           OR u.phone_number ILIKE $11 ESCAPE '!')
      AND ($13::boolean OR t.is_dispute)`;
  const search = f.search?.trim() || null;
  // "#12" or "12" is a ticket number, not a fragment of a phone number.
  const byNumber = search && /^#?\d{1,7}$/.test(search) ? search.replace(/^#/, '') : null;
  const params = [
    f.status ?? null,
    f.group ?? null,
    f.priority ?? null,
    f.category ?? null,
    f.kind ?? null,
    f.assigned ?? null,
    f.overdue ?? null,
    f.tripId ?? null,
    f.requesterId ?? null,
    byNumber,
    search && !byNumber ? likeContains(search) : null,
    adminId,
    general,
  ];
  const [rows, count] = await Promise.all([
    query<AdminRow>(
      `SELECT ${ADMIN_SELECT} FROM ${ADMIN_FROM} ${where}
       ORDER BY (t.status IN ${OPEN_SQL}) DESC, p.rank DESC, t.created_at ASC, t.id
       LIMIT $14 OFFSET $15`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    ),
    query<{ n: string }>(`SELECT count(*)::text AS n FROM ${ADMIN_FROM} ${where}`, params),
  ]);
  return { total: Number(count.rows[0]?.n ?? 0), items: rows.rows.map(toAdminRow) };
}

/** One ticket for an admin, or the same 404 a missing one gets when it is outside their permissions. */
async function adminTicketRow(adminId: string, id: string): Promise<AdminRow> {
  const r = await query<AdminRow>(`SELECT ${ADMIN_SELECT} FROM ${ADMIN_FROM} WHERE t.id = $1`, [
    id,
  ]);
  const row = r.rows[0];
  if (!row || (!row.is_dispute && !(await canSeeGeneral(adminId)))) throw notFound();
  return row;
}

export async function adminTicketDetail(adminId: string, id: string): Promise<AdminTicketDetail> {
  const row = await adminTicketRow(adminId, id);
  const canDecideRefunds = await hasPermission(adminId, 'REFUNDS_MANAGE');
  const [msgs, attachments, history, refunds, trip, payment, audit] = await Promise.all([
    query<{
      id: string;
      kind: AdminTicketMessage['kind'];
      author_kind: AdminTicketMessage['from'];
      author_name: string | null;
      body: string;
      created_at: Date;
    }>(
      `SELECT m.id, m.kind, m.author_kind, u.full_name AS author_name, m.body, m.created_at
       FROM support_messages m LEFT JOIN users u ON u.id = m.author_id
       WHERE m.ticket_id = $1 ORDER BY m.created_at, m.id`,
      [id],
    ),
    loadAttachments(id),
    query<{ id: string; number: string; subject: string; status: TicketStatus; created_at: Date }>(
      `SELECT id, number::text, subject, status, created_at FROM support_tickets
       WHERE requester_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 10`,
      [row.requester_id, id],
    ),
    adminRefundsForTicket(id, canDecideRefunds),
    row.trip_id ? getTrip(row.trip_id) : Promise.resolve(null),
    row.trip_id ? paymentContext(row.trip_id) : Promise.resolve(null),
    auditTrail('ticket', id),
  ]);
  let ride: AdminTicketDetail['ride'] = null;
  if (trip) {
    const names = await query<{ id: string; full_name: string | null }>(
      'SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])',
      [[trip.passenger_id, trip.driver_id].filter((x): x is string => x !== null)],
    );
    const nameOf = (uid: string | null) => names.rows.find((n) => n.id === uid)?.full_name ?? null;
    ride = {
      tripId: trip.id,
      status: trip.status,
      pickup: trip.pickup_name ?? trip.pickup_address,
      destination: trip.dest_name ?? trip.dest_address,
      requestedAt: trip.requested_at.toISOString(),
      passengerName: nameOf(trip.passenger_id),
      driverName: nameOf(trip.driver_id),
      fareEstimateNpr: trip.fare_estimate_npr,
      fareFinalNpr: trip.fare_final_npr,
      waitingChargeNpr: trip.waiting_charge_npr,
      cancellationFeeNpr: trip.cancellation_fee_npr,
      cancelledBy: trip.cancelled_by,
    };
  }
  // The ticket holds personal and financial context: opening it is itself recorded.
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'VIEW_SUPPORT_TICKET',
    subjectType: 'ticket',
    subjectIds: [id],
  });
  return {
    ...toAdminRow(row),
    messages: msgs.rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      from: m.author_kind,
      authorName: m.author_name,
      body: m.body,
      createdAt: m.created_at.toISOString(),
      attachments: attachments.get(m.id) ?? [],
    })),
    ride,
    payment,
    refunds,
    history: history.rows.map((h) => ({
      id: h.id,
      number: Number(h.number),
      subject: h.subject,
      status: h.status,
      createdAt: h.created_at.toISOString(),
    })),
    outcome: row.resolved_at ? row.outcome : null,
    resolution: row.resolved_at ? row.resolution_note : null,
    allowedNext: [...TICKET_TRANSITIONS[row.status]],
    canDecideRefunds,
    audit,
  };
}

/** Lock a ticket the admin is allowed to touch. */
async function lockForAdmin(client: PoolClient, adminId: string, id: string) {
  const general = await canSeeGeneral(adminId);
  const r = await client.query<{
    id: string;
    number: string;
    requester_id: string;
    status: TicketStatus;
    is_dispute: boolean;
    assigned_to: string | null;
    first_admin_response_at: Date | null;
  }>(
    `SELECT id, number::text, requester_id, status, is_dispute, assigned_to, first_admin_response_at
     FROM support_tickets WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const t = r.rows[0];
  if (!t || (!t.is_dispute && !general)) throw notFound();
  return t;
}

function invalidMove(from: TicketStatus): HttpError {
  const next = TICKET_TRANSITIONS[from].map((s) => TICKET_STATUS_LABELS[s]);
  return new HttpError(
    409,
    'INVALID_TICKET_TRANSITION',
    next.length === 0
      ? `This ticket is ${TICKET_STATUS_LABELS[from].toLowerCase()} and cannot change.`
      : `A ticket that is ${TICKET_STATUS_LABELS[from].toLowerCase()} can only become: ${next.join(', ')}.`,
  );
}

/** A reply from support. By default it hands the ticket to the person; it may also move it (not to a final state). */
export async function adminReply(
  adminId: string,
  id: string,
  input: AdminReplyBody,
  file?: UploadedFile,
): Promise<AdminTicketDetail> {
  if (!input.body && !file)
    throw new HttpError(400, 'VALIDATION_ERROR', 'Write a message or choose a file.');
  if (input.status === 'RESOLVED' || input.status === 'CLOSED') {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'To resolve or close a ticket, change its status and say what was decided.',
    );
  }
  const result = await withOptionalFile(id, file, async (client, attach) => {
    const t = await lockForAdmin(client, adminId, id);
    const target = input.status ?? statusAfterReply(t.status, 'ADMIN');
    if (target === null) throw new HttpError(409, 'TICKET_CLOSED', 'This ticket is closed.');
    if (target !== t.status && !canTicketTransition(t.status, target)) throw invalidMove(t.status);
    const messageId = await insertMessage(
      client,
      id,
      adminId,
      'ADMIN',
      'MESSAGE',
      input.body || attachedText(file as UploadedFile),
    );
    await attach(messageId, adminId);
    await client.query(
      `UPDATE support_tickets SET status = $2, updated_at = now(),
         assigned_to = COALESCE(assigned_to, $3),
         first_admin_response_at = COALESCE(first_admin_response_at, now()),
         resolved_at = CASE WHEN status = 'RESOLVED' AND $2 <> 'RESOLVED' THEN NULL ELSE resolved_at END
       WHERE id = $1`,
      [id, target, adminId],
    );
    return { t, target };
  });
  await notifyRequester(
    result.t.requester_id,
    SUPPORT_NOTIFICATION_TYPES.REPLY,
    `Support replied to request ${result.t.number}. Open it to read the reply.`,
    { ticketId: id },
  );
  return adminTicketDetail(adminId, id);
}

/** An internal note: never shown to the person, changes nothing, sends nothing. */
export async function adminNote(adminId: string, id: string, input: AdminNoteBody) {
  await withTransaction(async (client) => {
    await lockForAdmin(client, adminId, id);
    await insertMessage(client, id, adminId, 'ADMIN', 'NOTE', input.body);
  });
  return adminTicketDetail(adminId, id);
}

/** The one place an admin changes a ticket's status. Resolving needs the decision written down. */
export async function adminSetStatus(
  adminId: string,
  id: string,
  input: AdminStatusBody,
): Promise<AdminTicketDetail> {
  const to = input.status;
  const done = await withTransaction(async (client) => {
    const t = await lockForAdmin(client, adminId, id);
    if (!canTicketTransition(t.status, to)) throw invalidMove(t.status);
    if (to === 'RESOLVED') {
      if (!input.resolution?.trim() || input.resolution.trim().length < 3) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Say what was decided.').withDetails({
          resolution: ['Required'],
        });
      }
      if (t.is_dispute && !input.outcome) {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          'Say whether the problem was upheld or rejected.',
        ).withDetails({ outcome: ['Required'] });
      }
    }
    if ((to === 'RESOLVED' || to === 'CLOSED') && (await ticketHasActiveRefund(client, id))) {
      throw new HttpError(
        409,
        'REFUND_IN_PROGRESS',
        'A refund on this ticket is still being handled. Finish or reject it first.',
      );
    }
    await client.query(
      `UPDATE support_tickets SET status = $2, updated_at = now(),
         resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() WHEN $2 = 'CLOSED' THEN resolved_at ELSE NULL END,
         closed_at = CASE WHEN $2 = 'CLOSED' THEN now() ELSE NULL END,
         outcome = CASE WHEN $2 = 'RESOLVED' THEN $3 ELSE outcome END,
         resolution_note = CASE WHEN $2 = 'RESOLVED' THEN $4 ELSE resolution_note END,
         assigned_to = COALESCE(assigned_to, $5),
         first_admin_response_at = COALESCE(first_admin_response_at, now())
       WHERE id = $1`,
      [id, to, input.outcome ?? null, input.resolution?.trim() ?? null, adminId],
    );
    if (to === 'RESOLVED') {
      await insertMessage(
        client,
        id,
        adminId,
        'ADMIN',
        'RESOLUTION',
        (input.resolution as string).trim(),
      );
    } else {
      await insertMessage(
        client,
        id,
        null,
        'SYSTEM',
        'STATUS',
        `Status changed to ${TICKET_STATUS_LABELS[to].toLowerCase()}.`,
      );
    }
    return { t, from: t.status };
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'TICKET_STATUS_CHANGED',
    subjectType: 'ticket',
    subjectIds: [id],
    detail: { from: done.from, to, ...(input.outcome ? { outcome: input.outcome } : {}) },
  });
  await notifyRequester(
    done.t.requester_id,
    done.t.is_dispute
      ? SUPPORT_NOTIFICATION_TYPES.DISPUTE_UPDATED
      : SUPPORT_NOTIFICATION_TYPES.STATUS,
    describeTicketStatus(Number(done.t.number), to),
    { ticketId: id },
  );
  return adminTicketDetail(adminId, id);
}

export async function adminAssign(
  adminId: string,
  id: string,
  assigneeId: string | null,
): Promise<AdminTicketDetail> {
  if (assigneeId) {
    const ok = await query(
      `SELECT 1 FROM users WHERE id = $1 AND role = 'ADMIN' AND status = 'ACTIVE'`,
      [assigneeId],
    );
    // Whoever takes it must be able to work on it: a ticket is never parked with someone who cannot open it.
    if (!ok.rowCount || !(await hasPermission(assigneeId, 'DISPUTES_MANAGE'))) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'That administrator cannot handle support tickets.',
      );
    }
  }
  await withTransaction(async (client) => {
    const t = await lockForAdmin(client, adminId, id);
    if (assigneeId && !t.is_dispute && !(await hasPermission(assigneeId, 'SUPPORT_MANAGE'))) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'That administrator cannot handle general support tickets.',
      );
    }
    await client.query('UPDATE support_tickets SET assigned_to = $2 WHERE id = $1', [
      id,
      assigneeId,
    ]);
  });
  return adminTicketDetail(adminId, id);
}

export async function adminSetPriority(
  adminId: string,
  id: string,
  priorityCode: string,
): Promise<AdminTicketDetail> {
  const p = await query('SELECT 1 FROM support_priorities WHERE code = $1', [priorityCode]);
  if (!p.rowCount) throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown priority.');
  await withTransaction(async (client) => {
    await lockForAdmin(client, adminId, id);
    await client.query('UPDATE support_tickets SET priority = $2 WHERE id = $1', [
      id,
      priorityCode,
    ]);
  });
  return adminTicketDetail(adminId, id);
}

/** A file on a ticket, for an admin. The route records the download in the audit log. */
export async function adminAttachment(adminId: string, attachmentId: string) {
  const r = await query<{
    storage_key: string;
    content_type: string;
    filename: string;
    is_dispute: boolean;
  }>(
    `SELECT a.storage_key, a.content_type, a.filename, t.is_dispute FROM support_attachments a
     JOIN support_tickets t ON t.id = a.ticket_id WHERE a.id = $1`,
    [attachmentId],
  );
  const row = r.rows[0];
  if (!row || (!row.is_dispute && !(await canSeeGeneral(adminId)))) {
    throw new HttpError(404, 'NOT_FOUND', 'File not found.');
  }
  return signedUrl(row);
}

// ---------------------------------------------------------------- the sweeps

/**
 * Escalation and tidying, run on a timer. A ticket waiting on us longer than its priority allows is raised
 * to that priority's `escalates_to` (or, at the top, only the team is told), once per wait. A resolved
 * ticket nobody replied to is closed after SUPPORT_AUTO_CLOSE_DAYS. Both are single guarded statements, so
 * a sweep racing an admin or another instance changes each ticket at most once.
 */
export async function sweepSupport(): Promise<{ escalated: number; closed: number }> {
  const escalated = await query<{ id: string; number: string; assigned_to: string | null }>(
    `WITH due AS (
       SELECT t.id, p.escalates_to FROM support_tickets t
       JOIN support_priorities p ON p.code = t.priority
       WHERE t.status IN ${AWAITING_SQL}
         AND t.updated_at + p.first_response_hours * interval '1 hour' < now()
         AND (t.escalated_at IS NULL OR t.escalated_at < t.updated_at)
       FOR UPDATE OF t SKIP LOCKED)
     UPDATE support_tickets t SET escalation_level = t.escalation_level + 1, escalated_at = now(),
       priority = COALESCE(due.escalates_to, t.priority)
     FROM due WHERE t.id = due.id RETURNING t.id, t.number::text, t.assigned_to`,
  );
  for (const t of escalated.rows) {
    await query(
      `INSERT INTO support_messages (ticket_id, author_id, author_kind, kind, body)
       VALUES ($1, NULL, 'SYSTEM', 'NOTE', 'Escalated: no answer within the time allowed for its priority.')`,
      [t.id],
    );
    await notifySupportTeam({
      type: SUPPORT_NOTIFICATION_TYPES.ESCALATED,
      body: `Support request ${t.number} has waited too long and was escalated.`,
      ticketId: t.id,
    }).catch((err) => log.error('Escalation notice failed', err));
  }

  let closed = 0;
  const days = settingNumber('SUPPORT_AUTO_CLOSE_DAYS');
  if (days > 0) {
    const r = await query<{
      id: string;
      number: string;
      requester_id: string;
      is_dispute: boolean;
    }>(
      `UPDATE support_tickets SET status = 'CLOSED', closed_at = now(), updated_at = now()
       WHERE status = 'RESOLVED' AND resolved_at < now() - ($1::int * interval '1 day')
       RETURNING id, number::text, requester_id, is_dispute`,
      [days],
    );
    closed = r.rowCount ?? 0;
    for (const t of r.rows) {
      await query(
        `INSERT INTO support_messages (ticket_id, author_id, author_kind, kind, body)
         VALUES ($1, NULL, 'SYSTEM', 'STATUS', 'Closed automatically because it was resolved and nobody replied.')`,
        [t.id],
      );
      await notifyRequester(
        t.requester_id,
        t.is_dispute
          ? SUPPORT_NOTIFICATION_TYPES.DISPUTE_UPDATED
          : SUPPORT_NOTIFICATION_TYPES.STATUS,
        describeTicketStatus(Number(t.number), 'CLOSED'),
        { ticketId: t.id },
      );
    }
  }
  return { escalated: escalated.rowCount ?? 0, closed };
}

/** Count of refunds/tickets for dashboards: tickets not yet resolved or closed. */
export async function countOpenTickets(): Promise<{ open: number; disputes: number }> {
  const r = await query<{ open: number; disputes: number }>(
    `SELECT count(*)::int AS open, count(*) FILTER (WHERE is_dispute)::int AS disputes
     FROM support_tickets WHERE status IN ${OPEN_SQL}`,
  );
  return r.rows[0] ?? { open: 0, disputes: 0 };
}
