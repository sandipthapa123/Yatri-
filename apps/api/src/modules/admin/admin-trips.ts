import type { Request, Response } from 'express';
import {
  ACTIVE_TRIP_STATUSES,
  TRIP_STATUSES,
  type AdminTripDetail,
  type AdminTripRow,
  type ApiResponse,
  type ChatHistory,
  type TicketStatus,
  type TripStatus,
} from '@yatri/types';
import { z } from 'zod';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { sqlIn } from '../../lib/sql';
import { HttpError } from '../../middleware/errorHandler';
import { locationFreshness } from '../availability/availability.machine';
import { listCallsForTrip } from '../calls/calls.service';
import { getChatForAdmin } from '../chat/chat.service';
import { pricingConfigForCityId } from '../cities/city-rules';
import { getDriverFix } from '../tracking/tracking.service';
import { getPayment } from '../trips/payments.service';
import { listTripEvents } from '../trips/trip-events.service';
import { destinationOf, getTrip, pickupOf } from '../trips/trips.repository';
import { adminCancelTrip, metaFromRow } from '../trips/trips.service';
import { computeWaiting } from '../trips/waiting';
import { likeContains, rangeFields, resolveRange } from './admin-range';
import { hasPermission, recordAdminAccess } from './permissions';

export const adminTripsQuerySchema = z.object({
  ...rangeFields,
  status: z.enum(TRIP_STATUSES).optional(),
  /** active = still live, ended = completed / cancelled / no driver. */
  group: z.enum(['active', 'ended']).optional(),
  sort: z.enum(['live', 'newest', 'oldest', 'fare']).default('live'),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const adminCancelSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
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
           OR p.full_name ILIKE $2 ESCAPE '!' OR p.phone_number ILIKE $2 ESCAPE '!'
           OR d.full_name ILIKE $2 ESCAPE '!' OR d.phone_number ILIKE $2 ESCAPE '!')
      AND ($3::text IS NULL OR ($3 = 'active') = (t.status IN ${sqlIn(ACTIVE_TRIP_STATUSES)}))
      AND ($4::timestamptz IS NULL OR t.requested_at >= $4)
      AND ($5::timestamptz IS NULL OR t.requested_at < $5)`;
  // A period is only applied when one was asked for; otherwise every ride is listed.
  const period = q.range || q.from || q.to ? await resolveRange(q) : null;
  const filter = [
    q.status ?? null,
    q.search ? likeContains(q.search) : null,
    q.group ?? null,
    period?.from ?? null,
    period?.to ?? null,
  ];
  const order = {
    live: `(t.status IN ${sqlIn(ACTIVE_TRIP_STATUSES)}) DESC, t.requested_at DESC`,
    newest: 't.requested_at DESC',
    oldest: 't.requested_at ASC',
    fare: 'COALESCE(t.fare_final_npr, t.fare_estimate_npr) DESC NULLS LAST, t.requested_at DESC',
  }[q.sort];
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
      fare: number | null;
      payment_status: AdminTripRow['paymentStatus'] | null;
      payment_method: AdminTripRow['paymentMethod'];
      organization_name: string | null;
      open_disputes: string;
    }>(
      `SELECT t.id, t.status, p.full_name AS passenger_name, d.full_name AS driver_name,
              pl.place_name AS pickup_name, pl.address AS pickup_address,
              dl.place_name AS dest_name, dl.address AS dest_address,
              t.requested_at, t.ended_at, COALESCE(t.fare_final_npr, t.fare_estimate_npr) AS fare,
              (SELECT status FROM trip_payments WHERE trip_id = t.id) AS payment_status,
              (SELECT method FROM trip_payments WHERE trip_id = t.id) AS payment_method,
              (SELECT name FROM organizations WHERE id = t.organization_id) AS organization_name,
              (SELECT count(*) FROM support_tickets WHERE trip_id = t.id AND is_dispute AND status NOT IN ('RESOLVED', 'CLOSED'))::text AS open_disputes
       ${from}
       ORDER BY ${order}, t.id
       LIMIT $6 OFFSET $7`,
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
        fareNpr: r.fare,
        paymentStatus: r.payment_status ?? 'NONE',
        paymentMethod: r.payment_method,
        organizationName: r.organization_name,
        openDisputes: Number(r.open_disputes),
      })),
    },
  });
}

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
      query<{
        id: string;
        number: string;
        status: TicketStatus;
        category_label: string;
        requester_id: string;
        created_at: Date;
      }>(
        `SELECT t.id, t.number::text, t.status, c.label AS category_label, t.requester_id, t.created_at
         FROM support_tickets t JOIN support_categories c ON c.code = t.category_code
         WHERE t.trip_id = $1 AND t.is_dispute ORDER BY t.created_at`,
        [trip.id],
      ),
      getDriverFix(trip.id),
    ]);
  const business = trip.organization_id
    ? (
        await query<{ name: string; booked_by: string | null; code: string | null }>(
          `SELECT o.name, b.full_name AS booked_by, cc.code
           FROM organizations o LEFT JOIN users b ON b.id = $2
           LEFT JOIN organization_cost_centers cc ON cc.id = $3 WHERE o.id = $1`,
          [trip.organization_id, trip.booked_by, trip.cost_center_id],
        )
      ).rows[0]
    : undefined;
  const nameOf = (id: string | null) => names.rows.find((n) => n.id === id)?.full_name ?? null;
  const now = Date.now();

  const showPosition = canViewLocation && fix !== null;
  if (showPosition) await recordAdminAccess(admin, 'VIEW_TRIP_DRIVER_LOCATION', 'trip', [trip.id]);

  res.json({
    success: true,
    data: {
      business:
        trip.organization_id && business
          ? {
              organizationId: trip.organization_id,
              organizationName: business.name,
              bookedByName: business.booked_by,
              costCenterCode: business.code,
              purpose: trip.purpose,
            }
          : null,
      id: trip.id,
      status: trip.status,
      requestedAt: trip.requested_at.toISOString(),
      matchedAt: trip.matched_at?.toISOString() ?? null,
      arrivedAt: trip.arrived_at?.toISOString() ?? null,
      startedAt: trip.started_at?.toISOString() ?? null,
      endedAt: trip.ended_at?.toISOString() ?? null,
      cancelledBy: trip.cancelled_by,
      cancelledFromStatus: trip.cancelled_from_status,
      cancellationFeeNpr: trip.cancellation_fee_npr,
      vehicleCategory:
        trip.vehicle_category_code && trip.vehicle_category_label
          ? { code: trip.vehicle_category_code, label: trip.vehicle_category_label }
          : null,
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
              actualDistanceMeters: trip.actual_distance_meters,
              actualDurationSeconds: trip.actual_duration_seconds,
            },
      passenger: { id: trip.passenger_id, name: nameOf(trip.passenger_id) },
      driver: trip.driver_id ? { id: trip.driver_id, name: nameOf(trip.driver_id) } : null,
      waiting: computeWaiting(metaFromRow(trip), now, await pricingConfigForCityId(trip.city_id)),
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
      disputes: disputes.rows.map((d) => ({
        id: d.id,
        number: Number(d.number),
        status: d.status,
        categoryLabel: d.category_label,
        raisedByRole:
          d.requester_id === trip.passenger_id ? ('PASSENGER' as const) : ('DRIVER' as const),
        createdAt: d.created_at.toISOString(),
      })),
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
