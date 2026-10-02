import {
  ACTIVE_REFUND_STATES,
  PAYOUT_ACCOUNT_LABELS,
  PAYOUT_NOTIFICATION_TYPES,
  PAYOUT_STATUS_LABELS,
  PAYOUT_TRANSITIONS,
  canPayoutTransition,
  driverPayableForRide,
  driverPayoutSentences,
  normalizeAccountNumber,
  payoutAccountProblem,
  type AdminPayoutActionBody,
  type AdminPayoutDetail,
  type AdminPayoutList,
  type AdminPayoutRow,
  type DriverPayoutSummary,
  type PayoutAccountBody,
  type PayoutAccountKind,
  type PayoutFigures,
  type PayoutInfo,
  type PayoutStatus,
} from '@yatri/types';
import type { PoolClient } from 'pg';

import { env } from '../../config/env';
import { recordAudit } from '../../lib/audit';
import { decryptField, encryptField } from '../../lib/crypto';
import { query, withTransaction } from '../../lib/db';
import { log } from '../../lib/logger';
import { notify } from '../../lib/notifications';
import { sqlIn } from '../../lib/sql';
import { HttpError } from '../../middleware/errorHandler';
import { settingNumber } from '../settings/settings.service';

/**
 * Money owed to drivers for rides paid ONLINE, and getting it to them. A cash ride is never here: the driver was handed the
 * cash. An online ride is owed to the driver in full (a promotion is paid by Yatri), less the share of any refund on it that
 * the platform setting puts on the driver, after a hold that leaves room for a problem or a refund to be raised first.
 *
 * A ride can be in at most ONE payout, ever (`driver_payout_items.trip_id` is unique), so however many staff press "prepare"
 * at once, the same money is never prepared twice. Every payout goes through the one table in @yatri/types, the person who
 * prepared one cannot mark it paid, and the account to pay is read (decrypted) only by staff who manage payouts, each time audited.
 * Yatri has no payout API to a bank or wallet: staff send the money and record the reference. That is stated, not hidden.
 */
const PURPOSE = 'payout-account';
const secret = () => env.STORAGE_SIGNING_SECRET;
const ACTIVE = sqlIn(ACTIVE_REFUND_STATES);

const rules = () => ({
  holdHours: settingNumber('PAYOUT_HOLD_HOURS'),
  minNpr: settingNumber('PAYOUT_MIN_NPR'),
  driverSharePercent: settingNumber('ONLINE_REFUND_DRIVER_SHARE_PERCENT'),
});

// ---------------------------------------------------------------- what is owed

interface OwedRow {
  trip_id: string;
  fare: number;
  refunded: number;
  ready: boolean;
}

/**
 * THE definition of "an online ride not yet in a payout", with whether it is ready (past the hold, no refund being decided).
 * Used by the driver's balance, the staff's totals and the preparation of a payout, so they cannot disagree.
 */
const OWED_SQL = `
  SELECT t.id AS trip_id, t.fare_final_npr AS fare, t.driver_id,
         COALESCE((SELECT sum(f.amount_npr) FROM refunds f WHERE f.payment_id = p.id AND f.status = 'COMPLETED'), 0)::int AS refunded,
         (p.paid_at <= now() - ($1::int * interval '1 hour')
          AND NOT EXISTS (SELECT 1 FROM refunds f WHERE f.payment_id = p.id AND f.status IN ${ACTIVE})) AS ready
  FROM trips t JOIN trip_payments p ON p.trip_id = t.id
  WHERE t.status = 'COMPLETED' AND t.fare_final_npr IS NOT NULL AND p.method = 'DIGITAL' AND p.status = 'PAID'
    AND NOT EXISTS (SELECT 1 FROM driver_payout_items i WHERE i.trip_id = t.id)`;

const payable = (r: OwedRow) =>
  driverPayableForRide({ fareNpr: r.fare, refundedNpr: r.refunded, driverSharePercent: rules().driverSharePercent });

async function owedFor(driverId: string, client?: PoolClient): Promise<OwedRow[]> {
  const sql = `${OWED_SQL} AND t.driver_id = $2`;
  const args = [rules().holdHours, driverId];
  const r = client ? await client.query<OwedRow>(sql, args) : await query<OwedRow>(sql, args);
  return r.rows;
}

async function payoutTotals(driverId: string): Promise<{ inPayout: number; paid: number }> {
  const r = await query<{ in_payout: number; paid: number }>(
    `SELECT COALESCE(sum(amount_npr) FILTER (WHERE status IN ('PENDING', 'PROCESSING', 'FAILED')), 0)::int AS in_payout,
            COALESCE(sum(amount_npr) FILTER (WHERE status = 'PAID'), 0)::int AS paid
     FROM driver_payouts WHERE driver_id = $1`,
    [driverId],
  );
  return { inPayout: r.rows[0]?.in_payout ?? 0, paid: r.rows[0]?.paid ?? 0 };
}

/** Owed to every driver for online rides and ready now, in a payout under way, and paid: the staff's totals. */
export async function payoutFigures(): Promise<PayoutFigures> {
  const owed = await query<OwedRow>(OWED_SQL, [rules().holdHours]);
  const ready = owed.rows.filter((r) => r.ready).reduce((s, r) => s + payable(r), 0);
  const t = await query<{ in_payout: number; paid: number }>(
    `SELECT COALESCE(sum(amount_npr) FILTER (WHERE status IN ('PENDING', 'PROCESSING', 'FAILED')), 0)::int AS in_payout,
            COALESCE(sum(amount_npr) FILTER (WHERE status = 'PAID'), 0)::int AS paid FROM driver_payouts`,
  );
  return { readyNpr: ready, inPayoutNpr: t.rows[0]?.in_payout ?? 0, paidNpr: t.rows[0]?.paid ?? 0 };
}

// ---------------------------------------------------------------- the driver's side

interface PayoutRow {
  id: string;
  driver_id: string;
  amount_npr: number;
  status: PayoutStatus;
  account_kind: PayoutAccountKind;
  account_holder: string;
  account_cipher: string;
  account_last4: string;
  reference: string | null;
  failed_reason: string | null;
  created_by: string | null;
  decided_by: string | null;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}
const COLS = `id, driver_id, amount_npr, status, account_kind, account_holder, account_cipher, account_last4, reference,
  failed_reason, created_by, decided_by, created_at, updated_at, paid_at`;

const toInfo = (p: PayoutRow, rides: number): PayoutInfo => ({
  id: p.id,
  amountNpr: p.amount_npr,
  rides,
  status: p.status,
  statusText: statusSentence(p),
  createdAt: p.created_at.toISOString(),
  paidAt: p.paid_at?.toISOString() ?? null,
  reference: p.status === 'PAID' ? p.reference : null,
});

function statusSentence(p: Pick<PayoutRow, 'amount_npr' | 'status'>): string {
  const a = `NPR ${p.amount_npr}`;
  switch (p.status) {
    case 'PENDING':
      return `A payout of ${a} is prepared and will be sent soon.`;
    case 'PROCESSING':
      return `A payout of ${a} is being sent to you.`;
    case 'PAID':
      return `A payout of ${a} was paid to you.`;
    case 'FAILED':
      return `A payout of ${a} could not be sent. Yatri will try again; check your payout account.`;
    case 'CANCELLED':
      return `A payout of ${a} was cancelled. The rides in it will be paid out in a later payout.`;
  }
}

export async function driverSummary(driverId: string): Promise<DriverPayoutSummary> {
  const r = rules();
  const owed = await owedFor(driverId);
  const ready = owed.filter((x) => x.ready).reduce((s, x) => s + payable(x), 0);
  const holding = owed.filter((x) => !x.ready).reduce((s, x) => s + payable(x), 0);
  const t = await payoutTotals(driverId);
  const acc = await query<{ kind: PayoutAccountKind; holder_name: string; account_last4: string }>(
    'SELECT kind, holder_name, account_last4 FROM driver_payout_accounts WHERE driver_id = $1',
    [driverId],
  );
  const account = acc.rows[0] ? { kind: acc.rows[0].kind, holderName: acc.rows[0].holder_name, last4: acc.rows[0].account_last4 } : null;
  const base = { readyNpr: ready, holdingNpr: holding, inPayoutNpr: t.inPayout, paidNpr: t.paid, minPayoutNpr: r.minNpr, holdHours: r.holdHours, account };
  const list = await query<PayoutRow & { rides: number }>(
    `SELECT ${COLS}, (SELECT count(*)::int FROM driver_payout_items i WHERE i.payout_id = driver_payouts.id) AS rides
     FROM driver_payouts WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [driverId],
  );
  return { ...base, sentences: driverPayoutSentences(base), payouts: list.rows.map((p) => toInfo(p, p.rides)) };
}

export async function saveAccount(driverId: string, body: PayoutAccountBody): Promise<DriverPayoutSummary> {
  const problem = payoutAccountProblem(body);
  if (problem) throw new HttpError(400, 'VALIDATION_ERROR', problem);
  const number = normalizeAccountNumber(body.accountNumber);
  await query(
    `INSERT INTO driver_payout_accounts (driver_id, kind, holder_name, account_cipher, account_last4)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (driver_id) DO UPDATE SET kind = $2, holder_name = $3, account_cipher = $4, account_last4 = $5, updated_at = now()`,
    [driverId, body.kind, body.holderName.trim(), encryptField(number, secret(), PURPOSE), number.slice(-4)],
  );
  await recordAudit({ actorId: driverId, actorRole: 'DRIVER', action: 'PAYOUT_ACCOUNT_SAVED', subjectType: 'user', subjectIds: [driverId], detail: { kind: body.kind } });
  return driverSummary(driverId);
}

// ---------------------------------------------------------------- preparing a payout

/**
 * Prepare ONE driver's payout from what is ready now. Serialised per driver, and every ride lands in the items table whose
 * unique trip id refuses a ride that is already in a payout, so the same money cannot be prepared twice.
 */
export async function prepareForDriver(adminId: string, driverId: string): Promise<PayoutInfo> {
  const made = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`payout:${driverId}`]);
    const acc = await client.query<{ kind: PayoutAccountKind; holder_name: string; account_cipher: string; account_last4: string }>(
      'SELECT kind, holder_name, account_cipher, account_last4 FROM driver_payout_accounts WHERE driver_id = $1',
      [driverId],
    );
    const account = acc.rows[0];
    if (!account) throw new HttpError(409, 'NO_PAYOUT_ACCOUNT', 'This driver has not said where to send payouts.');
    const ready = (await owedFor(driverId, client)).filter((r) => r.ready);
    const items = ready.map((r) => ({ tripId: r.trip_id, amount: payable(r) })).filter((i) => i.amount > 0);
    const total = items.reduce((s, i) => s + i.amount, 0);
    if (total <= 0 || total < rules().minNpr) {
      throw new HttpError(409, 'BELOW_MINIMUM', `Less than NPR ${rules().minNpr} is ready for this driver.`);
    }
    const p = await client.query<PayoutRow>(
      `INSERT INTO driver_payouts (driver_id, amount_npr, account_kind, account_holder, account_cipher, account_last4, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
      [driverId, total, account.kind, account.holder_name, account.account_cipher, account.account_last4, adminId],
    );
    const payout = p.rows[0] as PayoutRow;
    for (const i of items) {
      await client.query('INSERT INTO driver_payout_items (payout_id, trip_id, amount_npr) VALUES ($1, $2, $3)', [payout.id, i.tripId, i.amount]);
    }
    return { payout, rides: items.length };
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'PAYOUT_PREPARED',
    subjectType: 'driver_payout',
    subjectIds: [made.payout.id],
    detail: { driverId, amountNpr: made.payout.amount_npr, rides: made.rides },
  });
  return toInfo(made.payout, made.rides);
}

/** Prepare a payout for every driver who has enough ready. Drivers without an account, or below the minimum, are skipped and counted. */
export async function prepareAll(adminId: string): Promise<{ prepared: number; skipped: number; totalNpr: number }> {
  const drivers = await query<{ driver_id: string }>(`SELECT DISTINCT driver_id FROM (${OWED_SQL}) o WHERE o.ready`, [rules().holdHours]);
  let prepared = 0;
  let skipped = 0;
  let totalNpr = 0;
  for (const d of drivers.rows) {
    try {
      const p = await prepareForDriver(adminId, d.driver_id);
      prepared += 1;
      totalNpr += p.amountNpr;
    } catch (err) {
      if (err instanceof HttpError) skipped += 1;
      else throw err;
    }
  }
  return { prepared, skipped, totalNpr };
}

// ---------------------------------------------------------------- moving a payout along

export async function actOnPayout(adminId: string, payoutId: string, body: AdminPayoutActionBody): Promise<AdminPayoutRow> {
  const out = await withTransaction(async (client) => {
    const cur = await client.query<PayoutRow>(`SELECT ${COLS} FROM driver_payouts WHERE id = $1 FOR UPDATE`, [payoutId]);
    const p = cur.rows[0];
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Payout not found.');
    if (!canPayoutTransition(p.status, body.to)) {
      const next = PAYOUT_TRANSITIONS[p.status].map((s) => PAYOUT_STATUS_LABELS[s].toLowerCase());
      throw new HttpError(
        409,
        'INVALID_PAYOUT_TRANSITION',
        next.length === 0
          ? `This payout is ${PAYOUT_STATUS_LABELS[p.status].toLowerCase()} and cannot change.`
          : `A payout that is ${PAYOUT_STATUS_LABELS[p.status].toLowerCase()} can only become: ${next.join(', ')}.`,
      );
    }
    if (body.to === 'PAID') {
      if (p.created_by === adminId) throw new HttpError(403, 'FOUR_EYES', 'Someone else must confirm a payout you prepared.');
      if (!body.reference?.trim()) throw new HttpError(400, 'VALIDATION_ERROR', 'Enter the bank or wallet reference of the payment you sent.');
    }
    if (body.to === 'FAILED' && !body.failedReason?.trim()) throw new HttpError(400, 'VALIDATION_ERROR', 'Say what went wrong.');
    const upd = await client.query<PayoutRow>(
      `UPDATE driver_payouts SET status = $2, updated_at = now(), decided_by = $3,
         reference = COALESCE($4, reference),
         failed_reason = CASE WHEN $2 = 'FAILED' THEN $5 WHEN $2 = 'PROCESSING' THEN NULL ELSE failed_reason END,
         paid_at = CASE WHEN $2 = 'PAID' THEN now() ELSE paid_at END
       WHERE id = $1 RETURNING ${COLS}`,
      [payoutId, body.to, adminId, body.reference?.trim() || null, body.failedReason?.trim() || null],
    );
    // A cancelled payout lets go of its rides, so a later payout can pay them.
    if (body.to === 'CANCELLED') await client.query('DELETE FROM driver_payout_items WHERE payout_id = $1', [payoutId]);
    const rides = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM driver_payout_items WHERE payout_id = $1', [payoutId]);
    return { row: upd.rows[0] as PayoutRow, from: p.status, rides: rides.rows[0]?.n ?? 0 };
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'PAYOUT_STATUS_CHANGED',
    subjectType: 'driver_payout',
    subjectIds: [payoutId],
    detail: { from: out.from, to: out.row.status, amountNpr: out.row.amount_npr, hasReference: !!body.reference },
  });
  if (out.row.status === 'PAID' || out.row.status === 'FAILED') {
    await notify({
      userId: out.row.driver_id,
      type: out.row.status === 'PAID' ? PAYOUT_NOTIFICATION_TYPES.PAYMENT_PAYOUT_SENT : PAYOUT_NOTIFICATION_TYPES.PAYMENT_PAYOUT_FAILED,
      title: out.row.status === 'PAID' ? 'Payout sent' : 'Payout could not be sent',
      body: statusSentence(out.row),
      metadata: { payoutId },
      dedupeKey: `payout:${payoutId}:${out.row.status}`,
    }).catch((err) => log.warn('Payout notification failed', err));
  }
  return toRow(out.row, out.rides, null);
}

// ---------------------------------------------------------------- the staff's views

const toRow = (p: PayoutRow, rides: number, driverName: string | null): AdminPayoutRow => ({
  id: p.id,
  driverId: p.driver_id,
  driverName,
  amountNpr: p.amount_npr,
  rides,
  status: p.status,
  statusLabel: PAYOUT_STATUS_LABELS[p.status],
  accountKind: p.account_kind,
  createdAt: p.created_at.toISOString(),
  paidAt: p.paid_at?.toISOString() ?? null,
});

export async function adminList(f: { status?: PayoutStatus | undefined; limit: number; offset: number }): Promise<AdminPayoutList> {
  const where = `($1::text IS NULL OR p.status = $1)`;
  const rows = await query<PayoutRow & { rides: number; full_name: string | null }>(
    `SELECT ${COLS.split(', ').map((c) => `p.${c.trim()}`).join(', ')}, u.full_name,
            (SELECT count(*)::int FROM driver_payout_items i WHERE i.payout_id = p.id) AS rides
     FROM driver_payouts p JOIN users u ON u.id = p.driver_id WHERE ${where}
     ORDER BY (p.status IN ('PENDING', 'PROCESSING', 'FAILED')) DESC, p.created_at DESC LIMIT $2 OFFSET $3`,
    [f.status ?? null, f.limit, f.offset],
  );
  const total = await query<{ n: number }>(`SELECT count(*)::int AS n FROM driver_payouts p WHERE ${where}`, [f.status ?? null]);
  const owed = await query<OwedRow & { driver_id: string }>(OWED_SQL, [rules().holdHours]);
  const ready = owed.rows.filter((r) => r.ready);
  return {
    items: rows.rows.map((p) => toRow(p, p.rides, p.full_name)),
    total: total.rows[0]?.n ?? 0,
    readyDrivers: new Set(ready.map((r) => r.driver_id)).size,
    readyNpr: ready.reduce((s, r) => s + payable(r), 0),
    limit: f.limit,
    offset: f.offset,
  };
}

export async function adminDetail(payoutId: string): Promise<AdminPayoutDetail> {
  const r = await query<PayoutRow & { full_name: string | null; creator: string | null; decider: string | null }>(
    `SELECT ${COLS.split(', ').map((c) => `p.${c.trim()}`).join(', ')}, u.full_name, c.full_name AS creator, d.full_name AS decider
     FROM driver_payouts p JOIN users u ON u.id = p.driver_id
     LEFT JOIN users c ON c.id = p.created_by LEFT JOIN users d ON d.id = p.decided_by WHERE p.id = $1`,
    [payoutId],
  );
  const p = r.rows[0];
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Payout not found.');
  const items = await query<{ trip_id: string; amount_npr: number }>('SELECT trip_id, amount_npr FROM driver_payout_items WHERE payout_id = $1 ORDER BY trip_id', [payoutId]);
  return {
    ...toRow(p, items.rows.length, p.full_name),
    accountHolder: p.account_holder,
    accountLast4: p.account_last4,
    reference: p.reference,
    failedReason: p.failed_reason,
    createdByName: p.creator,
    decidedByName: p.decider,
    allowedNext: [...PAYOUT_TRANSITIONS[p.status]],
    items: items.rows.map((i) => ({ tripId: i.trip_id, amountNpr: i.amount_npr })),
  };
}

/** The account to pay, in full, for staff who manage payouts. Each opening is audited. */
export async function revealAccount(adminId: string, payoutId: string): Promise<{ kind: PayoutAccountKind; kindLabel: string; holder: string; number: string }> {
  const r = await query<PayoutRow>(`SELECT ${COLS} FROM driver_payouts WHERE id = $1`, [payoutId]);
  const p = r.rows[0];
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Payout not found.');
  await recordAudit({ actorId: adminId, actorRole: 'ADMIN', action: 'PAYOUT_ACCOUNT_VIEWED', subjectType: 'driver_payout', subjectIds: [payoutId], detail: {} });
  return { kind: p.account_kind, kindLabel: PAYOUT_ACCOUNT_LABELS[p.account_kind].label, holder: p.account_holder, number: decryptField(p.account_cipher, secret(), PURPOSE) };
}
