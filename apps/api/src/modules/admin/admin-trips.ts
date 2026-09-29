import type { Request, Response } from 'express';
import {
  DISPUTE_STATUSES,
  TRIP_STATUSES,
  type AdminDisputeRow,
  type AdminTripDetail,
  type AdminTripRow,
  type ApiResponse,
  type ChatHistory,
  type DisputeInfo,
  type DisputeStatus,
  type TripStatus,
} from '@yatri/types';
import { z } from 'zod';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { locationFreshness } from '../availability/availability.machine';
import { listCallsForTrip } from '../calls/calls.service';
import { getChatForAdmin } from '../chat/chat.service';
import { pricingConfig } from '../pricing/pricing.config';
import { getDriverFix } from '../tracking/tracking.service';
import { resolveDispute } from '../trips/disputes.service';
import { getPayment } from '../trips/payments.service';
import { listTripEvents } from '../trips/trip-events.service';
import { destinationOf, getTrip, pickupOf } from '../trips/trips.repository';
import { adminCancelTrip, metaFromRow } from '../trips/trips.service';
import { computeWaiting } from '../trips/waiting';
import { hasPermission, recordAdminAccess } from './permissions';

export const adminTripsQuerySchema = z.object({
  status: z.enum(TRIP_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const adminCancelSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export const adminResolveSchema = z
  .object({
    status: z.enum(['RESOLVED', 'REJECTED']),
    resolution: z.string().trim().min(3).max(1000),
  })
  .strict();
export const adminDisputesQuerySchema = z.object({
  status: z.enum(DISPUTE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

function adminId(req: Request): string {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
}
const idParam = (req: Request) => {
  const v = req.params.id;
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

export async function listTripsHandler(
  req: Request,
  res: Response<ApiResponse<{ items: AdminTripRow[]; total: number }>>,
) {
  const q = req.validatedQuery as z.infer<typeof adminTripsQuerySchema>;
  const from = `
    FROM trips t
    JOIN locations pl ON pl.id = t.pickup_location_id
    JOIN locations dl ON dl.id = t.destination_location_id
    JOIN users p ON p.id = t.passenger_id
    LEFT JOIN users d ON d.id = t.driver_id
    WHERE ($1::text IS NULL OR t.status = $1)
      AND ($2::text IS NULL
           OR p.full_name ILIKE '%' || $2 || '%' OR p.phone_number ILIKE '%' || $2 || '%'
           OR d.full_name ILIKE '%' || $2 || '%' OR d.phone_number ILIKE '%' || $2 || '%')`;
  const filter = [q.status ?? null, q.search || null];
  const [rows, count] = await Promise.all([
    query<{
      id: string;
      status: TripStatus;
      passenger_name: string | null;
      driver_name: string | null;
      pickup_name: string | null;
      pickup_address: string;
      dest_name: string | null;
      dest_address: string;
      requested_at: Date;
      ended_at: Date | null;
      payment_status: AdminTripRow['paymentStatus'] | null;
      open_disputes: string;
    }>(
      `SELECT t.id, t.status, p.full_name AS passenger_name, d.full_name AS driver_name,
              pl.place_name AS pickup_name, pl.address AS pickup_address,
              dl.place_name AS dest_name, dl.address AS dest_address,
              t.requested_at, t.ended_at,
              (SELECT status FROM trip_payments WHERE trip_id = t.id) AS payment_status,
              (SELECT count(*) FROM trip_disputes WHERE trip_id = t.id AND status = 'OPEN')::text AS open_disputes
       ${from}
       ORDER BY (t.status IN ('SEARCHING', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS')) DESC,
                t.requested_at DESC
       LIMIT $3 OFFSET $4`,
      [...filter, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, filter),
  ]);
  res.json({
    success: true,
    data: {
      total: Number(count.rows[0]?.n ?? 0),
      items: rows.rows.map((r) => ({
        id: r.id,
        status: r.status,
        passengerName: r.passenger_name,
        driverName: r.driver_name,
        pickupName: r.pickup_name ?? r.pickup_address,
        destinationName: r.dest_name ?? r.dest_address,
        requestedAt: r.requested_at.toISOString(),
        endedAt: r.ended_at?.toISOString() ?? null,
        paymentStatus: r.payment_status ?? 'NONE',
        openDisputes: Number(r.open_disputes),
      })),
    },
  });
}

interface DisputeRow {
  id: string;
  trip_id: string;
  status: DisputeStatus;
  reason: string;
  resolution: string | null;
  created_at: Date;
  resolved_at: Date | null;
  raised_by: string;
}
const toDispute = (r: DisputeRow, passengerId: string): AdminTripDetail['disputes'][number] => ({
  id: r.id,
  tripId: r.trip_id,
  status: r.status,
  reason: r.reason,
  resolution: r.resolution,
  createdAt: r.created_at.toISOString(),
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  raisedByRole: r.raised_by === passengerId ? 'PASSENGER' : 'DRIVER',
});

export async function tripDetailHandler(req: Request, res: Response<ApiResponse<AdminTripDetail>>) {
  const admin = adminId(req);
  const trip = await getTrip(idParam(req));
  if (!trip) throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');

  const [canViewLocation, canViewChat] = await Promise.all([
    hasPermission(admin, 'DRIVER_LOCATION_VIEW'),
    hasPermission(admin, 'TRIP_CHAT_VIEW'),
  ]);
  const people = [trip.passenger_id, trip.driver_id].filter((x): x is string => x !== null);

  const [names, events, offers, calls, chatCount, payment, ratings, disputes, fix] =
    await Promise.all([
      query<{ id: string; full_name: string | null }>(
        'SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])',
        [people],
      ),
      listTripEvents(trip.id, { limit: 500 }),
      query<{
        full_name: string | null;
        status: string;
        pickup_distance_meters: number;
        offered_at: Date;
        responded_at: Date | null;
      }>(
        `SELECT u.full_name, o.status, o.pickup_distance_meters, o.offered_at, o.responded_at
         FROM trip_offers o JOIN users u ON u.id = o.driver_id
         WHERE o.trip_id = $1 ORDER BY o.offered_at`,
        [trip.id],
      ),
      listCallsForTrip(trip.id),
      query<{ n: string }>('SELECT count(*)::text AS n FROM trip_messages WHERE trip_id = $1', [
        trip.id,
      ]),
      getPayment(trip.id),
      query<{ rater_role: string; stars: number; comment: string | null }>(
        'SELECT rater_role, stars, comment FROM trip_ratings WHERE trip_id = $1 ORDER BY created_at',
        [trip.id],
      ),
      query<DisputeRow>(
        `SELECT id, trip_id, status, reason, resolution, created_at, resolved_at, raised_by
         FROM trip_disputes WHERE trip_id = $1 ORDER BY created_at`,
        [trip.id],
      ),
      getDriverFix(trip.id),
    ]);
  const nameOf = (id: string | null) => names.rows.find((n) => n.id === id)?.full_name ?? null;
  const now = Date.now();

  const showPosition = canViewLocation && fix !== null;
  if (showPosition) await recordAdminAccess(admin, 'VIEW_TRIP_DRIVER_LOCATION', 'trip', [trip.id]);

  res.json({
    success: true,
    data: {
      id: trip.id,
      status: trip.status,
      requestedAt: trip.requested_at.toISOString(),
      matchedAt: trip.matched_at?.toISOString() ?? null,
      arrivedAt: trip.arrived_at?.toISOString() ?? null,
      startedAt: trip.started_at?.toISOString() ?? null,
      endedAt: trip.ended_at?.toISOString() ?? null,
      cancelledBy: trip.cancelled_by,
      cancelReason: trip.cancel_reason,
      pickup: pickupOf(trip),
      destination: destinationOf(trip),
      fare:
        trip.fare_estimate_npr === null
          ? null
          : {
              estimateNpr: trip.fare_estimate_npr,
              waitingChargeNpr: trip.waiting_charge_npr,
              finalNpr: trip.fare_final_npr,
              distanceMeters: trip.distance_meters ?? 0,
            },
      passenger: { id: trip.passenger_id, name: nameOf(trip.passenger_id) },
      driver: trip.driver_id ? { id: trip.driver_id, name: nameOf(trip.driver_id) } : null,
      waiting: computeWaiting(metaFromRow(trip), now, pricingConfig()),
      location: {
        driverFreshness: locationFreshness(
          fix?.receivedAtMs ?? null,
          now,
          env.DRIVER_LOCATION_FRESH_SECONDS,
        ),
        lastUpdateAt: fix ? new Date(fix.receivedAtMs).toISOString() : null,
        driverPosition:
          showPosition && fix
            ? { latitude: fix.latitude, longitude: fix.longitude, accuracyMeters: null }
            : null,
      },
      events,
      offers: offers.rows.map((o) => ({
        driverName: o.full_name,
        status: o.status,
        pickupDistanceMeters: o.pickup_distance_meters,
        offeredAt: o.offered_at.toISOString(),
        respondedAt: o.responded_at?.toISOString() ?? null,
      })),
      calls,
      chat: { messageCount: Number(chatCount.rows[0]?.n ?? 0), canViewContent: canViewChat },
      payment,
      ratings: ratings.rows.map((r) => ({
        raterRole: r.rater_role,
        stars: r.stars,
        comment: r.comment,
      })),
      disputes: disputes.rows.map((d) => toDispute(d, trip.passenger_id)),
    },
  });
}

/** Chat content needs its own permission, and every read is written to the access log. */
export async function tripChatHandler(req: Request, res: Response<ApiResponse<ChatHistory>>) {
  const admin = adminId(req);
  if (!(await hasPermission(admin, 'TRIP_CHAT_VIEW'))) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to read trip chats.');
  }
  const trip = await getTrip(idParam(req));
  if (!trip) throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
  await recordAdminAccess(admin, 'VIEW_TRIP_CHAT', 'trip', [trip.id]);
  res.json({ success: true, data: await getChatForAdmin(trip.id) });
}

export async function adminCancelHandler(
  req: Request,
  res: Response<ApiResponse<{ status: TripStatus }>>,
) {
  const { reason } = req.body as z.infer<typeof adminCancelSchema>;
  const trip = await adminCancelTrip(idParam(req), adminId(req), reason);
  res.json({ success: true, data: { status: trip.status } });
}

export async function listDisputesHandler(
  req: Request,
  res: Response<ApiResponse<{ items: AdminDisputeRow[]; total: number }>>,
) {
  const q = req.validatedQuery as z.infer<typeof adminDisputesQuerySchema>;
  const from = `
    FROM trip_disputes x
    JOIN trips t ON t.id = x.trip_id
    JOIN users p ON p.id = t.passenger_id
    LEFT JOIN users d ON d.id = t.driver_id
    WHERE ($1::text IS NULL OR x.status = $1)`;
  const [rows, count] = await Promise.all([
    query<
      DisputeRow & {
        passenger_id: string;
        passenger_name: string | null;
        driver_name: string | null;
      }
    >(
      `SELECT x.id, x.trip_id, x.status, x.reason, x.resolution, x.created_at, x.resolved_at,
              x.raised_by, t.passenger_id, p.full_name AS passenger_name, d.full_name AS driver_name
       ${from}
       ORDER BY (x.status = 'OPEN') DESC, x.created_at DESC LIMIT $2 OFFSET $3`,
      [q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, [q.status ?? null]),
  ]);
  res.json({
    success: true,
    data: {
      total: Number(count.rows[0]?.n ?? 0),
      items: rows.rows.map((r) => ({
        ...toDispute(r, r.passenger_id),
        passengerName: r.passenger_name,
        driverName: r.driver_name,
      })),
    },
  });
}

export async function resolveDisputeHandler(req: Request, res: Response<ApiResponse<DisputeInfo>>) {
  const b = req.body as z.infer<typeof adminResolveSchema>;
  res.json({
    success: true,
    data: await resolveDispute(idParam(req), adminId(req), b.status, b.resolution),
  });
}
