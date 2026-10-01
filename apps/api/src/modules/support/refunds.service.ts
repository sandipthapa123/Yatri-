import {
  ACTIVE_REFUND_STATES,
  REFUND_STATUS_LABELS,
  REFUND_TRANSITIONS,
  SUPPORT_NOTIFICATION_TYPES,
  canRefundTransition,
  describeRefundStatus,
  type AdminRefundActionBody,
  type AdminRefundCreateBody,
  type AdminRefundInfo,
  type RefundInfo,
  type RefundMethod,
  type RefundQuote,
  type RefundReason,
  type RefundRequestBody,
  type RefundStatus,
  type TicketPaymentContext,
  type TripRole,
} from '@yatri/types';
import type { PoolClient } from 'pg';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { sqlIn } from '../../lib/sql';
import { HttpError } from '../../middleware/errorHandler';
import { quoteRefund, refundAmountFor } from '../pricing/refunds';
import { notifyRequester } from './support-notify';

/**
 * Refunds. A refund refers to the payment of a ride (trip_payments) and to the ticket it came from; it
 * never edits the payment. What has been paid back is the sum of COMPLETED refunds, the amounts come from
 * ONE calculation (pricing/refunds), and the legal moves are the table in @yatri/types, applied here with
 * a row lock so two admins acting at once cannot both win. Yatri holds no wallet: PROCESSING and COMPLETED
 * record who returned the money and how; nothing here moves money.
 */
interface RefundRow {
  id: string;
  ticket_id: string | null;
  trip_id: string;
  payment_id: string;
  requested_by: string | null;
  requested_by_role: 'PASSENGER' | 'DRIVER' | 'ADMIN';
  amount_npr: number;
  reason: RefundReason;
  status: RefundStatus;
  method: RefundMethod | null;
  reference: string | null;
  decision_note: string | null;
  failed_reason: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}
const COLS = `r.id, r.ticket_id, r.trip_id, r.payment_id, r.requested_by, r.requested_by_role, r.amount_npr,
  r.reason, r.status, r.method, r.reference, r.decision_note, r.failed_reason, r.created_at, r.updated_at,
  r.completed_at`;

const toInfo = (r: RefundRow): RefundInfo => ({
  id: r.id,
  ticketId: r.ticket_id,
  tripId: r.trip_id,
  amountNpr: r.amount_npr,
  reason: r.reason,
  status: r.status,
  statusText: describeRefundStatus(r.amount_npr, r.status),
  method: r.method,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
});

interface PaymentBasisRow {
  id: string;
  amount_npr: number;
  status: string;
  method: string;
  paid_at: Date | null;
  waiting_charge_npr: number;
  refunded: number;
}

/** The payment of a ride with what has been refunded on it (the COMPLETED refunds only). */
async function paymentBasis(tripId: string, client?: PoolClient): Promise<PaymentBasisRow | null> {
  const run = client ? client.query.bind(client) : query;
  const r = await run(
    `SELECT p.id, p.amount_npr, p.status, p.method, p.paid_at, t.waiting_charge_npr,
            COALESCE((SELECT sum(amount_npr) FROM refunds f WHERE f.payment_id = p.id AND f.status = 'COMPLETED'), 0)::int AS refunded
     FROM trip_payments p JOIN trips t ON t.id = p.trip_id WHERE p.trip_id = $1`,
    [tripId],
  );
  return (r.rows[0] as PaymentBasisRow | undefined) ?? null;
}

const quoteFrom = (p: PaymentBasisRow): RefundQuote =>
  quoteRefund({
    paidNpr: p.amount_npr,
    refundedNpr: p.refunded,
    waitingChargeNpr: p.waiting_charge_npr,
  });

/** What an admin sees of the payment for a ride, with the figures a refund would be checked against. */
export async function paymentContext(tripId: string): Promise<TicketPaymentContext | null> {
  const p = await paymentBasis(tripId);
  if (!p) return null;
  return {
    amountNpr: p.amount_npr,
    status: p.status,
    method: p.method,
    paidAt: p.paid_at?.toISOString() ?? null,
    refundedNpr: p.refunded,
    quote: p.status === 'PAID' ? quoteFrom(p) : null,
  };
}

const ACTIVE = sqlIn(ACTIVE_REFUND_STATES);

/** Whether a ticket still has a refund being decided (a ticket cannot be finished while one is). */
export async function ticketHasActiveRefund(
  client: PoolClient,
  ticketId: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM refunds WHERE ticket_id = $1 AND status IN ${ACTIVE} LIMIT 1`,
    [ticketId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** What this passenger could ask for on their ride problem, with the same figures the server checks a request against. */
export async function refundQuoteForRequester(
  userId: string,
  ticketId: string,
): Promise<RefundQuote> {
  const t = await query<{ trip_id: string | null; requester_role: TripRole; is_dispute: boolean }>(
    'SELECT trip_id, requester_role, is_dispute FROM support_tickets WHERE id = $1 AND requester_id = $2',
    [ticketId, userId],
  );
  const row = t.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found.');
  if (row.requester_role !== 'PASSENGER' || !row.trip_id || !row.is_dispute) {
    throw new HttpError(
      409,
      'NO_RIDE_TO_REFUND',
      'A refund can only be asked for on a ride problem.',
    );
  }
  const p = await paymentBasis(row.trip_id);
  if (!p || p.status !== 'PAID') {
    throw new HttpError(409, 'PAYMENT_NOT_PAID', 'This ride has no confirmed payment to refund.');
  }
  return quoteFrom(p);
}

/** The person's own view: their latest refund on this ticket, and whether they may ask for one now. */
export async function refundViewForRequester(ticket: {
  id: string;
  trip_id: string | null;
  requester_role: TripRole;
  is_dispute: boolean;
  status: string;
}): Promise<{ refund: RefundInfo | null; canRequestRefund: boolean }> {
  const latest = await query<RefundRow>(
    `SELECT ${COLS} FROM refunds r WHERE r.ticket_id = $1 ORDER BY r.created_at DESC LIMIT 1`,
    [ticket.id],
  );
  const refund = latest.rows[0] ? toInfo(latest.rows[0]) : null;
  let canRequestRefund = false;
  if (
    ticket.trip_id &&
    ticket.is_dispute &&
    ticket.requester_role === 'PASSENGER' &&
    ticket.status !== 'CLOSED'
  ) {
    const p = await paymentBasis(ticket.trip_id);
    const active = await query(
      'SELECT 1 FROM refunds WHERE payment_id = $1 AND status IN ' + ACTIVE,
      [p?.id ?? null],
    );
    canRequestRefund =
      !!p && p.status === 'PAID' && quoteFrom(p).remainingNpr > 0 && !active.rowCount;
  }
  return { refund, canRequestRefund };
}

async function createRefund(
  client: PoolClient,
  ticket: { id: string; trip_id: string | null; is_dispute: boolean },
  by: { userId: string; role: 'PASSENGER' | 'ADMIN' },
  body: RefundRequestBody,
): Promise<RefundRow> {
  if (!ticket.trip_id || !ticket.is_dispute) {
    throw new HttpError(
      409,
      'NO_RIDE_TO_REFUND',
      'A refund can only be asked for on a ride problem.',
    );
  }
  // Lock the payment so two requests for the same ride are worked out one after the other.
  await client.query('SELECT 1 FROM trip_payments WHERE trip_id = $1 FOR UPDATE', [ticket.trip_id]);
  const p = await paymentBasis(ticket.trip_id, client);
  const billed = await client.query(
    "SELECT 1 FROM trip_payments WHERE trip_id = $1 AND method = 'ORGANIZATION'",
    [ticket.trip_id],
  );
  if (billed.rowCount) {
    throw new HttpError(
      409,
      'BILLED_TO_ORGANIZATION',
      'This ride was billed to an organization, so it is not refunded to the rider. Support will settle it with the organization.',
    );
  }
  if (!p || p.status !== 'PAID') {
    throw new HttpError(409, 'PAYMENT_NOT_PAID', 'This ride has no confirmed payment to refund.');
  }
  const quote = quoteFrom(p);
  if (quote.remainingNpr <= 0) {
    throw new HttpError(
      409,
      'ALREADY_REFUNDED',
      'Everything paid for this ride has already been refunded.',
    );
  }
  const check = refundAmountFor(quote, body.reason, body.amountNpr);
  if (!check.ok) throw new HttpError(400, 'INVALID_REFUND_AMOUNT', check.message);
  try {
    const r = await client.query<RefundRow>(
      `INSERT INTO refunds (ticket_id, trip_id, payment_id, requested_by, requested_by_role, amount_npr, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, ticket_id, trip_id, payment_id, requested_by, requested_by_role, amount_npr, reason,
                 status, method, reference, decision_note, failed_reason, created_at, updated_at, completed_at`,
      [ticket.id, ticket.trip_id, p.id, by.userId, by.role, check.amountNpr, body.reason],
    );
    return r.rows[0] as RefundRow;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(
        409,
        'REFUND_ALREADY_ACTIVE',
        'A refund for this ride is already being handled.',
      );
    }
    throw err;
  }
}

async function lockTicket(client: PoolClient, id: string) {
  const r = await client.query<{
    id: string;
    number: string;
    requester_id: string;
    requester_role: TripRole;
    trip_id: string | null;
    is_dispute: boolean;
    status: string;
  }>(
    `SELECT id, number::text, requester_id, requester_role, trip_id, is_dispute, status
     FROM support_tickets WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return r.rows[0];
}

async function systemNote(client: PoolClient, ticketId: string, body: string) {
  await client.query(
    `INSERT INTO support_messages (ticket_id, author_id, author_kind, kind, body, created_at)
     VALUES ($1, NULL, 'SYSTEM', 'STATUS', $2, clock_timestamp())`,
    [ticketId, body],
  );
}

/** A passenger asks for a refund on their ride problem. Decided later by people who may (REFUNDS_MANAGE). */
export async function requestRefundAsRequester(
  userId: string,
  ticketId: string,
  body: RefundRequestBody,
): Promise<RefundInfo> {
  const row = await withTransaction(async (client) => {
    const t = await lockTicket(client, ticketId);
    if (!t || t.requester_id !== userId) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found.');
    if (t.requester_role !== 'PASSENGER') {
      throw new HttpError(403, 'FORBIDDEN', 'Only the passenger can ask for a refund.');
    }
    if (t.status === 'CLOSED') {
      throw new HttpError(409, 'TICKET_CLOSED', 'This request is closed.');
    }
    const r = await createRefund(client, t, { userId, role: 'PASSENGER' }, body);
    await systemNote(client, t.id, `A refund of NPR ${r.amount_npr} was requested.`);
    return { r, number: Number(t.number) };
  });
  await recordAudit({
    actorId: userId,
    actorRole: 'PASSENGER',
    action: 'REFUND_REQUESTED',
    subjectType: 'refund',
    subjectIds: [row.r.id],
    detail: { ticketId, amountNpr: row.r.amount_npr, reason: row.r.reason },
  });
  return toInfo(row.r);
}

/** A support admin raises a refund on a ticket (it still needs someone else to approve it). */
export async function createRefundAsAdmin(
  adminId: string,
  ticketId: string,
  body: AdminRefundCreateBody,
): Promise<RefundInfo> {
  const r = await withTransaction(async (client) => {
    const t = await lockTicket(client, ticketId);
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found.');
    if (t.status === 'CLOSED') throw new HttpError(409, 'TICKET_CLOSED', 'This ticket is closed.');
    const created = await createRefund(client, t, { userId: adminId, role: 'ADMIN' }, body);
    if (body.note) {
      await client.query(`UPDATE refunds SET decision_note = $2 WHERE id = $1`, [
        created.id,
        body.note,
      ]);
    }
    await systemNote(client, t.id, `A refund of NPR ${created.amount_npr} was raised.`);
    return created;
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'REFUND_RAISED',
    subjectType: 'refund',
    subjectIds: [r.id],
    detail: { ticketId, amountNpr: r.amount_npr, reason: r.reason },
  });
  return toInfo(r);
}

/** The refunds on a ticket as an admin sees them, with the moves this admin may make. */
export async function adminRefundsForTicket(
  ticketId: string,
  canDecide: boolean,
): Promise<AdminRefundInfo[]> {
  const r = await query<RefundRow & { requester_name: string | null; decider_name: string | null }>(
    `SELECT ${COLS}, ru.full_name AS requester_name, du.full_name AS decider_name
     FROM refunds r
     LEFT JOIN users ru ON ru.id = r.requested_by
     LEFT JOIN users du ON du.id = COALESCE(r.decided_by, r.processed_by)
     WHERE r.ticket_id = $1 ORDER BY r.created_at DESC`,
    [ticketId],
  );
  return r.rows.map((x) => ({
    ...toInfo(x),
    requestedByName: x.requester_name,
    requestedByRole: x.requested_by_role,
    decidedByName: x.decider_name,
    decisionNote: x.decision_note,
    reference: x.reference,
    failedReason: x.failed_reason,
    allowedNext: canDecide ? [...REFUND_TRANSITIONS[x.status]] : [],
  }));
}

/**
 * Move a refund along its lifecycle. One guarded path for every step: the row is locked, the move is
 * checked against the table, the details that step needs are required, and the four-eyes rule holds
 * (whoever raised a refund cannot approve it). Completing also re-checks the payment cannot be over-refunded.
 */
export async function actOnRefund(
  adminId: string,
  refundId: string,
  body: AdminRefundActionBody,
): Promise<RefundInfo> {
  const { row, from, ticket } = await withTransaction(async (client) => {
    const cur = await client.query<RefundRow>(
      `SELECT ${COLS} FROM refunds r WHERE r.id = $1 FOR UPDATE`,
      [refundId],
    );
    const current = cur.rows[0];
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'Refund not found.');
    const to = body.to;
    if (!canRefundTransition(current.status, to)) {
      const next = REFUND_TRANSITIONS[current.status].map((s) => REFUND_STATUS_LABELS[s]);
      throw new HttpError(
        409,
        'INVALID_REFUND_TRANSITION',
        next.length === 0
          ? `This refund is ${REFUND_STATUS_LABELS[current.status].toLowerCase()} and cannot change.`
          : `A refund that is ${REFUND_STATUS_LABELS[current.status].toLowerCase()} can only become: ${next.join(', ')}.`,
      );
    }
    if (to === 'APPROVED' && current.requested_by === adminId) {
      throw new HttpError(403, 'FOUR_EYES', 'Someone else must approve a refund you raised.');
    }
    if (to === 'REJECTED' && !body.note?.trim()) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'Say why the refund is not approved.',
      ).withDetails({
        note: ['Required'],
      });
    }
    if (to === 'PROCESSING' && !(body.method ?? current.method)) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'Choose how the money is paid back.',
      ).withDetails({
        method: ['Required'],
      });
    }
    if (to === 'FAILED' && !body.failedReason?.trim()) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Say what went wrong.').withDetails({
        failedReason: ['Required'],
      });
    }
    if (to === 'COMPLETED') {
      // Nothing may be paid back beyond what was paid, even if figures moved since approval.
      await client.query('SELECT 1 FROM trip_payments WHERE id = $1 FOR UPDATE', [
        current.payment_id,
      ]);
      const p = await paymentBasis(current.trip_id, client);
      if (!p || p.refunded + current.amount_npr > p.amount_npr) {
        throw new HttpError(409, 'REFUND_EXCEEDS_PAYMENT', 'This would refund more than was paid.');
      }
    }
    const upd = await client.query<RefundRow>(
      `UPDATE refunds r SET status = $2, updated_at = now(),
         decided_by = CASE WHEN $2 IN ('APPROVED', 'REJECTED') THEN $3::uuid ELSE r.decided_by END,
         decided_at = CASE WHEN $2 IN ('APPROVED', 'REJECTED') THEN now() ELSE r.decided_at END,
         decision_note = CASE WHEN $4::text IS NOT NULL AND $2 IN ('APPROVED', 'REJECTED', 'REVIEWING') THEN $4 ELSE r.decision_note END,
         method = COALESCE($5, r.method),
         processed_by = CASE WHEN $2 IN ('PROCESSING', 'COMPLETED', 'FAILED') THEN $3::uuid ELSE r.processed_by END,
         reference = COALESCE($6, r.reference),
         failed_reason = CASE WHEN $2 = 'FAILED' THEN $7 WHEN $2 = 'PROCESSING' THEN NULL ELSE r.failed_reason END,
         completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE r.completed_at END
       WHERE r.id = $1
       RETURNING ${COLS}`,
      [
        refundId,
        to,
        adminId,
        body.note?.trim() || null,
        body.method ?? null,
        body.reference?.trim() || null,
        body.failedReason?.trim() || null,
      ],
    );
    const updated = upd.rows[0] as RefundRow;
    let ticketRow: Awaited<ReturnType<typeof lockTicket>> | undefined;
    if (updated.ticket_id) {
      ticketRow = await lockTicket(client, updated.ticket_id);
      await systemNote(
        client,
        updated.ticket_id,
        `Refund of NPR ${updated.amount_npr}: ${REFUND_STATUS_LABELS[to].toLowerCase()}.`,
      );
    }
    return { row: updated, from: current.status, ticket: ticketRow };
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'REFUND_STATUS_CHANGED',
    subjectType: 'refund',
    subjectIds: [row.id],
    detail: { from, to: row.status, amountNpr: row.amount_npr },
  });
  // The person who asked is told about a decision and about the money reaching them.
  const recipient = ticket?.requester_id;
  if (recipient && ['APPROVED', 'REJECTED', 'COMPLETED'].includes(row.status)) {
    await notifyRequester(
      recipient,
      row.status === 'COMPLETED'
        ? SUPPORT_NOTIFICATION_TYPES.REFUND_COMPLETED
        : SUPPORT_NOTIFICATION_TYPES.REFUND_DECISION,
      describeRefundStatus(row.amount_npr, row.status),
      { ticketId: row.ticket_id, refundId: row.id },
    );
  }
  return toInfo(row);
}
