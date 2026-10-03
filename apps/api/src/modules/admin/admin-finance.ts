import { isoOrNull } from '../../lib/dates';
import { pageParam, pageSizeParam } from '../../lib/pagination';
import {
  FINANCE_NOT_SUPPORTED,
  PAYMENT_STATUSES,
  type AdminListResponse,
  type AdminPaymentRow,
  type ApiResponse,
  type DriverEarningsRow,
  type FinanceSummary,
  type PaymentStatus,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { payoutFigures } from '../payouts/payouts.service';
import { likeContains, rangeFields, resolveRange, type RangeQuery } from './admin-range';

/**
 * Financial views. Yatri takes cash, paid straight to the driver, so the platform holds no money:
 * there are payments (one per completed ride), what was collected, and what each driver earned —
 * and NO wallets or payouts, which the summary says plainly instead of showing empty tables.
 * Every read is written to the audit log (who looked at money, and over what range).
 */
const page = {
  page: pageParam,
  pageSize: pageSizeParam(50, 20),
};

export const adminPaymentsQuerySchema = z.object({
  ...rangeFields,
  status: z.enum(PAYMENT_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(['newest', 'oldest', 'amount']).default('newest'),
  ...page,
});
export const adminFinanceRangeSchema = z.object(rangeFields);
export const adminEarningsQuerySchema = z.object({
  ...rangeFields,
  sort: z.enum(['earned', 'rides', 'name']).default('earned'),
  search: z.string().trim().max(100).optional(),
  ...page,
});

async function audited(req: Request, action: string, detail: Record<string, unknown>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  await recordAudit({
    actorId: req.auth.userId,
    actorRole: 'ADMIN',
    action,
    subjectType: 'finance',
    subjectIds: null,
    detail,
  });
}

export async function paymentsHandler(
  req: Request,
  res: Response<ApiResponse<AdminListResponse<AdminPaymentRow>>>,
) {
  const q = req.validatedQuery as z.infer<typeof adminPaymentsQuerySchema>;
  const range = await resolveRange(q, '30d');
  const params = [range.from, range.to, q.status ?? null, q.search ? likeContains(q.search) : null];
  const from = `
    FROM trip_payments p
    JOIN trips t ON t.id = p.trip_id
    JOIN users pa ON pa.id = t.passenger_id
    LEFT JOIN users dr ON dr.id = t.driver_id
    WHERE t.requested_at >= $1 AND t.requested_at < $2
      AND ($3::text IS NULL OR p.status = $3)
      AND ($4::text IS NULL OR pa.full_name ILIKE $4 ESCAPE '!' OR dr.full_name ILIKE $4 ESCAPE '!'
           OR pa.phone_number ILIKE $4 ESCAPE '!' OR dr.phone_number ILIKE $4 ESCAPE '!'
           OR p.trip_id::text = $5)`;
  const order = {
    newest: 'p.created_at DESC',
    oldest: 'p.created_at ASC',
    amount: 'p.amount_npr DESC',
  }[q.sort];
  const searchExact = q.search ?? null;
  const [rows, count] = await Promise.all([
    query<{
      id: string;
      trip_id: string;
      amount_npr: number;
      method: string;
      status: PaymentStatus;
      passenger: string | null;
      driver: string | null;
      created_at: Date;
      paid_at: Date | null;
    }>(
      `SELECT p.id, p.trip_id, p.amount_npr, p.method, p.status, pa.full_name AS passenger,
              dr.full_name AS driver, p.created_at, p.paid_at
       ${from} ORDER BY ${order}, p.id LIMIT $6 OFFSET $7`,
      [...params, searchExact, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n ${from}`, [...params, searchExact]),
  ]);
  await audited(req, 'VIEW_PAYMENTS', { range: range.label, shown: rows.rows.length });
  res.json({
    success: true,
    data: {
      items: rows.rows.map((r) => ({
        id: r.id,
        tripId: r.trip_id,
        amountNpr: r.amount_npr,
        method: r.method,
        status: r.status,
        passengerName: r.passenger,
        driverName: r.driver,
        createdAt: r.created_at.toISOString(),
        paidAt: isoOrNull(r.paid_at),
      })),
      total: count.rows[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    },
  });
}

export async function financeSummaryHandler(
  req: Request,
  res: Response<ApiResponse<FinanceSummary>>,
) {
  const range = await resolveRange(req.validatedQuery as RangeQuery, '30d');
  const p = [range.from, range.to];
  const [byStatus, totals] = await Promise.all([
    query<{ status: PaymentStatus; n: number; amount: number }>(
      `SELECT p.status, count(*)::int AS n, COALESCE(sum(p.amount_npr), 0)::int AS amount
       FROM trip_payments p JOIN trips t ON t.id = p.trip_id
       WHERE t.requested_at >= $1 AND t.requested_at < $2 GROUP BY p.status`,
      p,
    ),
    query<{ gross: number; collected: number; fees: number; discounts: number }>(
      `SELECT COALESCE(sum(t.fare_final_npr) FILTER (WHERE t.status = 'COMPLETED'), 0)::int AS gross,
              COALESCE(sum(t.discount_npr) FILTER (WHERE t.status = 'COMPLETED'), 0)::int AS discounts,
              COALESCE(sum(pay.amount_npr) FILTER (WHERE t.status = 'COMPLETED'), 0)::int AS collected,
              COALESCE(sum(t.cancellation_fee_npr) FILTER (WHERE t.status = 'CANCELLED'), 0)::int AS fees
       FROM trips t LEFT JOIN trip_payments pay ON pay.trip_id = t.id AND pay.status = 'PAID'
       WHERE t.requested_at >= $1 AND t.requested_at < $2`,
      p,
    ),
  ]);
  const online = await query<{ collected: number; refunded: number }>(
    `SELECT COALESCE(sum(p.amount_npr) FILTER (WHERE p.status = 'PAID'), 0)::int AS collected,
            COALESCE((SELECT sum(f.amount_npr) FROM refunds f JOIN trip_payments fp ON fp.id = f.payment_id
                      WHERE f.status = 'COMPLETED' AND fp.method = 'DIGITAL' AND f.completed_at >= $1 AND f.completed_at < $2), 0)::int AS refunded
     FROM trip_payments p JOIN trips t ON t.id = p.trip_id
     WHERE p.method = 'DIGITAL' AND t.requested_at >= $1 AND t.requested_at < $2`,
    p,
  );
  const status = Object.fromEntries(
    PAYMENT_STATUSES.map((s) => {
      const r = byStatus.rows.find((x) => x.status === s);
      return [s, { count: r?.n ?? 0, amountNpr: r?.amount ?? 0 }];
    }),
  ) as FinanceSummary['byStatus'];
  const t = totals.rows[0] ?? { gross: 0, collected: 0, fees: 0, discounts: 0 };
  await audited(req, 'VIEW_FINANCE_SUMMARY', { range: range.label });
  res.json({
    success: true,
    data: {
      range,
      byStatus: status,
      grossFaresNpr: t.gross,
      collectedNpr: t.collected,
      outstandingNpr: Math.max(0, t.gross - t.discounts - t.collected),
      discountsFundedNpr: t.discounts,
      cancellationFeesNpr: t.fees,
      wallets: { supported: false, reason: FINANCE_NOT_SUPPORTED },
      payouts: await payoutFigures(),
      onlineCollectedNpr: online.rows[0]?.collected ?? 0,
      onlineRefundedNpr: online.rows[0]?.refunded ?? 0,
    },
  });
}

export async function earningsHandler(
  req: Request,
  res: Response<ApiResponse<AdminListResponse<DriverEarningsRow>>>,
) {
  const q = req.validatedQuery as z.infer<typeof adminEarningsQuerySchema>;
  const range = await resolveRange(q, '30d');
  const params = [range.from, range.to, q.search ? likeContains(q.search) : null];
  const from = `
    FROM trips t
    JOIN users d ON d.id = t.driver_id
    LEFT JOIN trip_payments pay ON pay.trip_id = t.id AND pay.status = 'PAID'
    WHERE t.status = 'COMPLETED' AND t.requested_at >= $1 AND t.requested_at < $2
      AND ($3::text IS NULL OR d.full_name ILIKE $3 ESCAPE '!' OR d.phone_number ILIKE $3 ESCAPE '!')
    GROUP BY d.id, d.full_name`;
  const order = {
    earned: 'earned DESC',
    rides: 'rides DESC',
    name: 'lower(d.full_name) ASC NULLS LAST',
  }[q.sort];
  const [rows, count] = await Promise.all([
    query<{
      id: string;
      name: string | null;
      rides: number;
      earned: number;
      collected: number;
      discounts: number;
    }>(
      `SELECT d.id, d.full_name AS name, count(*)::int AS rides,
              COALESCE(sum(t.fare_final_npr), 0)::int AS earned,
              COALESCE(sum(t.discount_npr), 0)::int AS discounts,
              COALESCE(sum(pay.amount_npr), 0)::int AS collected
       ${from} ORDER BY ${order}, d.id LIMIT $4 OFFSET $5`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT 1 ${from}) x`, params),
  ]);
  await audited(req, 'VIEW_DRIVER_EARNINGS', { range: range.label, shown: rows.rows.length });
  res.json({
    success: true,
    data: {
      items: rows.rows.map((r) => ({
        driverId: r.id,
        driverName: r.name,
        rides: r.rides,
        earnedNpr: r.earned,
        collectedNpr: r.collected,
        outstandingNpr: Math.max(0, r.earned - r.discounts - r.collected),
        discountsNpr: r.discounts,
      })),
      total: count.rows[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    },
  });
}
