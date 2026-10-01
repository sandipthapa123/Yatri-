import {
  ORG_PAYMENT_MODE_METHOD,
  type OrgPaymentMode,
  type PaymentInfo,
  type PaymentMethod,
  type PaymentStatus,
} from '@yatri/types';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { recordTripEvent } from './trip-events.service';
import { getTrip } from './trips.repository';
import { requireParticipant } from './access';

/**
 * Payment is its own axis (trip_payments), never a trip status. The provider interface is the
 * seam for real gateways (eSewa, Khalti, cards): each is one class that proves a payment
 * happened. Only CASH is implemented — the driver confirms the cash they received. No gateway
 * is claimed or faked; adding one needs its merchant credentials and its own adapter.
 */
export interface PaymentProvider {
  readonly method: PaymentMethod;
  /** Verify the payment is genuinely settled and return a reference. Throws HttpError if not. */
  settle(ctx: {
    tripId: string;
    amountNpr: number;
    actorId: string;
    driverId: string;
  }): Promise<{ providerRef: string | null }>;
}

export const cashProvider: PaymentProvider = {
  method: 'CASH',
  async settle(ctx) {
    // Cash has no third party: only the trip's own driver can say the cash arrived.
    if (ctx.actorId !== ctx.driverId) {
      throw new HttpError(403, 'FORBIDDEN', 'Only the driver can confirm a cash payment.');
    }
    return { providerRef: null };
  },
};

/**
 * A ride billed to an organization has nothing to collect: nobody can "settle" it from the ride. It is paid
 * when the organization pays its monthly statement, which an administrator records (organizations/statements.ts,
 * the only writer of that change).
 */
export const organizationProvider: PaymentProvider = {
  method: 'ORGANIZATION',
  async settle() {
    throw new HttpError(
      409,
      'BILLED_TO_ORGANIZATION',
      "This ride is billed to the rider's organization. There is no cash to collect.",
    );
  },
};

const providers: Record<PaymentMethod, PaymentProvider> = {
  CASH: cashProvider,
  ORGANIZATION: organizationProvider,
};

interface PaymentRow {
  trip_id: string;
  amount_npr: number;
  method: PaymentMethod;
  status: PaymentStatus;
  paid_at: Date | null;
}

const toInfo = (r: PaymentRow): PaymentInfo => ({
  tripId: r.trip_id,
  amountNpr: r.amount_npr,
  method: r.method,
  status: r.status,
  paidAt: r.paid_at?.toISOString() ?? null,
});

/** Created once, when the trip completes, for exactly the server-calculated final fare. */
export async function createPendingPayment(tripId: string, amountNpr: number): Promise<void> {
  // The method follows the organization's payment mode when the ride was booked for one (the one rule is
  // ORG_PAYMENT_MODE_METHOD); every other ride is cash.
  const org = await query<{ payment_mode: OrgPaymentMode }>(
    `SELECT p.payment_mode FROM trips t JOIN organization_policies p ON p.organization_id = t.organization_id
     WHERE t.id = $1`,
    [tripId],
  );
  const method: PaymentMethod = org.rows[0]
    ? ORG_PAYMENT_MODE_METHOD[org.rows[0].payment_mode]
    : 'CASH';
  await query(
    `INSERT INTO trip_payments (trip_id, amount_npr, method, status)
     VALUES ($1, $2, $3, 'PENDING') ON CONFLICT (trip_id) DO NOTHING`,
    [tripId, amountNpr, method],
  );
}

export async function getPayment(tripId: string): Promise<PaymentInfo | null> {
  const r = await query<PaymentRow>(
    'SELECT trip_id, amount_npr, method, status, paid_at FROM trip_payments WHERE trip_id = $1',
    [tripId],
  );
  return r.rows[0] ? toInfo(r.rows[0]) : null;
}

/** Participants may read their trip's payment; anyone else gets the same 404 as a missing trip. */
export async function getPaymentFor(tripId: string, userId: string): Promise<PaymentInfo> {
  await requireParticipant(tripId, userId);
  const p = await getPayment(tripId);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'No payment is due for this trip yet.');
  return p;
}

export async function settlePayment(tripId: string, actorId: string): Promise<PaymentInfo> {
  const trip = await getTrip(tripId);
  if (!trip || (trip.passenger_id !== actorId && trip.driver_id !== actorId)) {
    throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
  }
  if (trip.status !== 'COMPLETED' || !trip.driver_id) {
    throw new HttpError(
      409,
      'TRIP_NOT_COMPLETED',
      'Payment can only be settled after the ride ends.',
    );
  }
  const current = await getPayment(tripId);
  if (!current) throw new HttpError(404, 'NOT_FOUND', 'No payment is due for this trip.');
  if (current.status === 'PAID') return current; // idempotent
  if (current.status !== 'PENDING') {
    throw new HttpError(409, 'PAYMENT_NOT_PENDING', 'This payment can no longer be settled.');
  }

  const { providerRef } = await providers[current.method].settle({
    tripId,
    amountNpr: current.amountNpr,
    actorId,
    driverId: trip.driver_id,
  });

  const r = await query<PaymentRow>(
    `UPDATE trip_payments SET status = 'PAID', paid_at = now(), confirmed_by = $2, provider_ref = $3
     WHERE trip_id = $1 AND status = 'PENDING'
     RETURNING trip_id, amount_npr, method, status, paid_at`,
    [tripId, actorId, providerRef],
  );
  if (!r.rows[0]) return (await getPayment(tripId)) as PaymentInfo; // lost a race: already settled
  await recordTripEvent({
    tripId,
    type: 'PAYMENT_RECEIVED',
    actorId,
    payload: { amountNpr: current.amountNpr, method: current.method },
  });
  return toInfo(r.rows[0]);
}
