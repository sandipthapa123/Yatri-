import { recordAudit } from '../../lib/audit';
import { log } from '../../lib/logger';
import { query } from '../../lib/db';
import { settleRide } from '../growth/engine';
import { createPendingPayment } from './payments.service';

/**
 * Payment reconciliation (the `payment-reconcile` job). Payments are written in the same step that completes a ride, but
 * a crash between the two steps must not leave a finished ride that nobody can be paid for, so this looks at the data and
 * puts right what can be put right safely, and reports (never silently changes) what cannot:
 *  - FIXED: a completed ride with a final fare and no payment record gets its pending payment (the same idempotent
 *    insert the completion uses, so running it twice, or racing the completion, cannot create two);
 *  - REPORTED only: a statement marked paid with a payment that is not, a cancelled statement still holding payments, an
 *    issued statement holding none, a refund stuck in processing for a day. Money states are decided by people.
 */
export interface ReconcileResult {
  created: number;
  anomalies: {
    statementPaidWithUnpaid: number;
    voidStatementWithPayments: number;
    emptyIssuedStatement: number;
    refundsStuck: number;
  };
}

export async function reconcilePayments(): Promise<ReconcileResult> {
  const missing = await query<{ id: string; fare: number }>(
    `SELECT t.id, t.fare_final_npr AS fare FROM trips t
     WHERE t.status = 'COMPLETED' AND t.fare_final_npr IS NOT NULL
       AND t.ended_at < now() - interval '1 minute'
       AND NOT EXISTS (SELECT 1 FROM trip_payments p WHERE p.trip_id = t.id)
     ORDER BY t.ended_at LIMIT 200`,
  );
  const created: string[] = [];
  for (const t of missing.rows) {
    // The ride's offers and points are settled (idempotently) first, so the payment is for what the rider owes.
    // If settling fails, leave the ride for the next run: a payment made now would be for the full fare, and settling
    // never revisits a ride that already has a payment, so the rider's offer or points would be lost for good.
    let settled: Awaited<ReturnType<typeof settleRide>>;
    try {
      settled = await settleRide(t.id);
    } catch (err) {
      log.error('Could not settle a ride before its payment; will retry', err);
      continue;
    }
    await createPendingPayment(t.id, t.fare - settled.discountNpr);
    created.push(t.id);
  }
  if (created.length > 0) {
    await recordAudit({
      actorId: null,
      actorRole: 'SYSTEM',
      action: 'PAYMENTS_RECONCILED',
      subjectType: 'trip',
      subjectIds: created,
      detail: { created: created.length },
    });
  }

  const count = async (sql: string) => Number((await query<{ n: number }>(sql)).rows[0]?.n ?? 0);
  const anomalies = {
    statementPaidWithUnpaid: await count(
      `SELECT count(DISTINCT s.id)::int AS n FROM organization_statements s
       JOIN trip_payments p ON p.statement_id = s.id WHERE s.status = 'PAID' AND p.status <> 'PAID'`,
    ),
    voidStatementWithPayments: await count(
      `SELECT count(DISTINCT s.id)::int AS n FROM organization_statements s
       JOIN trip_payments p ON p.statement_id = s.id WHERE s.status = 'VOID'`,
    ),
    emptyIssuedStatement: await count(
      `SELECT count(*)::int AS n FROM organization_statements s
       WHERE s.status = 'ISSUED' AND NOT EXISTS (SELECT 1 FROM trip_payments p WHERE p.statement_id = s.id)`,
    ),
    refundsStuck: await count(
      `SELECT count(*)::int AS n FROM refunds WHERE status = 'PROCESSING' AND updated_at < now() - interval '24 hours'`,
    ),
  };
  const total = Object.values(anomalies).reduce((a, b) => a + b, 0);
  if (total > 0) {
    await recordAudit({
      actorId: null,
      actorRole: 'SYSTEM',
      action: 'PAYMENT_ANOMALIES_FOUND',
      subjectType: 'payment_reconcile',
      subjectIds: null,
      detail: { ...anomalies },
    });
  }
  return { created: created.length, anomalies };
}
