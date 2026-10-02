import type { DigitalPaymentInfo, PaymentAttemptStatus } from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { log } from '../../lib/logger';
import { env } from '../../config/env';
import { HttpError } from '../../middleware/errorHandler';
import { getPaymentGateway } from '../payments/gateway';
import { ProviderError } from '../providers/errors';
import { requireParticipant } from './access';
import { getPayment, markPaidByProvider } from './payments.service';
import { getTrip } from './trips.repository';

/**
 * Paying a finished ride online. Yatri decides everything that matters: whose ride it is, how much is owed (the payment
 * record the server created at completion), and whether the vendor's report is believed (only a server-to-server lookup,
 * for exactly that amount). A rider coming back from the vendor's page proves nothing.
 *
 * Idempotency, in the database: one open attempt per ride (asking again returns it), one vendor reference per attempt, one
 * completed attempt per ride. A repeated tap, a repeated verify and the background sweep all end in one payment.
 */
interface AttemptRow {
  id: string;
  trip_id: string;
  provider: string;
  provider_ref: string | null;
  amount_npr: number;
  status: PaymentAttemptStatus;
  payment_url: string | null;
  expires_at: Date | null;
}

const COLUMNS = 'id, trip_id, provider, provider_ref, amount_npr, status, payment_url, expires_at';

const toInfo = (a: AttemptRow): DigitalPaymentInfo => ({
  attemptId: a.id,
  status: a.status,
  amountNpr: a.amount_npr,
  paymentUrl: a.status === 'INITIATED' ? a.payment_url : null,
  expiresAt: a.status === 'INITIATED' ? (a.expires_at?.toISOString() ?? null) : null,
});

const unavailable = () =>
  new HttpError(
    503,
    'DIGITAL_PAYMENTS_UNAVAILABLE',
    'Online payment is not available right now. You can pay the driver in cash instead.',
  );

/** The rider of a completed ride, with a payment still to be made, and not billed to an organization. */
async function payableFor(tripId: string, userId: string): Promise<{ amountNpr: number }> {
  const trip = await getTrip(tripId);
  if (!trip || trip.passenger_id !== userId) {
    await requireParticipant(tripId, userId); // the same 404 as any other stranger
    throw new HttpError(403, 'FORBIDDEN', 'Only the rider can pay for this ride online.');
  }
  const payment = await getPayment(tripId);
  if (trip.status !== 'COMPLETED' || !payment) {
    throw new HttpError(409, 'TRIP_NOT_COMPLETED', 'You can pay online after the ride ends.');
  }
  if (payment.method === 'ORGANIZATION') {
    throw new HttpError(409, 'BILLED_TO_ORGANIZATION', "This ride is billed to your organization.");
  }
  if (payment.status === 'PAID') throw new HttpError(409, 'ALREADY_PAID', 'This ride is already paid.');
  if (payment.status !== 'PENDING') {
    throw new HttpError(409, 'PAYMENT_NOT_PENDING', 'This payment can no longer be made.');
  }
  return { amountNpr: payment.amountNpr };
}

export async function startDigitalPayment(tripId: string, userId: string): Promise<DigitalPaymentInfo> {
  const gateway = getPaymentGateway();
  if (!gateway) throw unavailable();
  const { amountNpr } = await payableFor(tripId, userId);
  if (amountNpr === 0) throw new HttpError(409, 'NOTHING_TO_PAY', 'Nothing is owed for this ride.');

  // An open attempt that is still good is returned as it is (a repeated request is not a second payment).
  await expireStale(tripId);
  const existing = await query<AttemptRow>(
    `SELECT ${COLUMNS} FROM payment_attempts WHERE trip_id = $1 AND status = 'INITIATED'`,
    [tripId],
  );
  if (existing.rows[0]) return toInfo(existing.rows[0]);

  const inserted = await query<AttemptRow>(
    `INSERT INTO payment_attempts (trip_id, provider, amount_npr, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 minute'))
     ON CONFLICT (trip_id) WHERE status = 'INITIATED' DO NOTHING
     RETURNING ${COLUMNS}`,
    [tripId, gateway.name, amountNpr, userId, env.PAYMENT_ATTEMPT_TTL_MINUTES],
  );
  const attempt = inserted.rows[0];
  if (!attempt) {
    // Lost a race with the same rider's other request: theirs is the one open attempt.
    const again = await query<AttemptRow>(
      `SELECT ${COLUMNS} FROM payment_attempts WHERE trip_id = $1 AND status = 'INITIATED'`,
      [tripId],
    );
    if (again.rows[0]) return toInfo(again.rows[0]);
    throw unavailable();
  }

  try {
    const opened = await gateway.initiate({
      attemptId: attempt.id,
      tripId,
      amountNpr,
      description: 'Yatri ride',
    });
    const done = await query<AttemptRow>(
      `UPDATE payment_attempts SET provider_ref = $2, payment_url = $3, expires_at = COALESCE($4, expires_at)
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [attempt.id, opened.providerRef, opened.paymentUrl, opened.expiresAt],
    );
    await recordAudit({
      actorId: userId,
      actorRole: 'PASSENGER',
      action: 'PAYMENT_ATTEMPT_STARTED',
      subjectType: 'trip',
      subjectIds: [tripId],
      detail: { provider: gateway.name, amountNpr },
    });
    return toInfo(done.rows[0] as AttemptRow);
  } catch (err) {
    await query(`UPDATE payment_attempts SET status = 'FAILED' WHERE id = $1 AND status = 'INITIATED'`, [attempt.id]);
    if (err instanceof ProviderError) throw unavailable(); // the vendor's reason stays in the server's counters
    throw err;
  }
}

async function expireStale(tripId: string): Promise<void> {
  await query(
    `UPDATE payment_attempts SET status = 'EXPIRED'
     WHERE trip_id = $1 AND status = 'INITIATED' AND expires_at IS NOT NULL AND expires_at < now()`,
    [tripId],
  );
}

/** Ask the vendor about one attempt and apply the answer. Returns the attempt as it now stands. */
async function applyLookup(a: AttemptRow, actorId: string | null): Promise<AttemptRow> {
  if (a.status !== 'INITIATED' || !a.provider_ref) return a;
  const gateway = getPaymentGateway();
  if (!gateway || gateway.name !== a.provider) throw unavailable();
  let result;
  try {
    result = await gateway.lookup(a.provider_ref);
  } catch (err) {
    if (err instanceof ProviderError) throw unavailable();
    throw err;
  }
  if (result.state === 'PENDING') return a;
  if (result.state === 'EXPIRED' || result.state === 'FAILED') {
    const next: PaymentAttemptStatus = result.state === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
    const r = await query<AttemptRow>(
      `UPDATE payment_attempts SET status = $2 WHERE id = $1 AND status = 'INITIATED' RETURNING ${COLUMNS}`,
      [a.id, next],
    );
    return r.rows[0] ?? a;
  }
  // COMPLETED: believed only for exactly the amount Yatri asked for.
  if (result.amountNpr !== a.amount_npr) {
    log.error('Payment amount mismatch; not marking paid');
    await query(`UPDATE payment_attempts SET status = 'FAILED' WHERE id = $1 AND status = 'INITIATED'`, [a.id]);
    await recordAudit({
      actorId,
      actorRole: actorId ? 'PASSENGER' : 'SYSTEM',
      action: 'PAYMENT_AMOUNT_MISMATCH',
      subjectType: 'trip',
      subjectIds: [a.trip_id],
      detail: { provider: a.provider, expectedNpr: a.amount_npr },
    });
    throw new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', 'The payment did not match the amount due. It was not accepted.');
  }
  await markPaidByProvider({ tripId: a.trip_id, actorId, providerRef: a.provider_ref, amountNpr: a.amount_npr });
  const r = await query<AttemptRow>(
    `UPDATE payment_attempts SET status = 'COMPLETED', completed_at = COALESCE(completed_at, now())
     WHERE id = $1 AND status = 'INITIATED' RETURNING ${COLUMNS}`,
    [a.id],
  );
  if (r.rows[0]) {
    await recordAudit({
      actorId,
      actorRole: actorId ? 'PASSENGER' : 'SYSTEM',
      action: 'PAYMENT_COMPLETED_ONLINE',
      subjectType: 'trip',
      subjectIds: [a.trip_id],
      detail: { provider: a.provider, amountNpr: a.amount_npr },
    });
  }
  return r.rows[0] ?? { ...a, status: 'COMPLETED' };
}

/** The rider asks "did it go through?" (and the app calls this when they come back from the vendor's page). */
export async function verifyDigitalPayment(tripId: string, userId: string): Promise<DigitalPaymentInfo> {
  const trip = await getTrip(tripId);
  if (!trip || trip.passenger_id !== userId) {
    await requireParticipant(tripId, userId);
    throw new HttpError(403, 'FORBIDDEN', 'Only the rider can check this payment.');
  }
  await expireStale(tripId);
  const latest = await query<AttemptRow>(
    `SELECT ${COLUMNS} FROM payment_attempts WHERE trip_id = $1
     ORDER BY (status = 'INITIATED') DESC, (status = 'COMPLETED') DESC, created_at DESC LIMIT 1`,
    [tripId],
  );
  const a = latest.rows[0];
  if (!a) throw new HttpError(404, 'NOT_FOUND', 'No online payment was started for this ride.');
  return toInfo(await applyLookup(a, userId));
}

/**
 * The `payment-attempts` job: settle attempts whose rider never came back to the app (the vendor took the money, the phone
 * died), and close the ones that ran out of time. Same code path as the rider's own check, so the same guards apply.
 */
export async function sweepPaymentAttempts(limit = 100): Promise<{ checked: number; completed: number; closed: number }> {
  const due = await query<AttemptRow>(
    `SELECT ${COLUMNS} FROM payment_attempts
     WHERE status = 'INITIATED' AND provider_ref IS NOT NULL AND created_at < now() - interval '1 minute'
     ORDER BY created_at LIMIT $1`,
    [limit],
  );
  let completed = 0;
  let closed = 0;
  for (const a of due.rows) {
    try {
      const after = await applyLookup(a, null);
      if (after.status === 'COMPLETED') completed += 1;
      else if (after.status !== 'INITIATED') closed += 1;
    } catch (err) {
      log.warn('Payment attempt check failed; will try again', err instanceof Error ? err.name : 'error');
    }
  }
  const expired = await query(
    `UPDATE payment_attempts SET status = 'EXPIRED'
     WHERE status = 'INITIATED' AND expires_at IS NOT NULL AND expires_at < now()`,
  );
  closed += expired.rowCount ?? 0;
  return { checked: due.rows.length, completed, closed };
}
