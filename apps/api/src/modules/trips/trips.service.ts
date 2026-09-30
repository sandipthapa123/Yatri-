import {
  TERMINAL_TRIP_STATUSES,
  haversineMeters,
  type TripCounterpart,
  type TripEventPayload,
  type TripEventType,
  type RideCategoryOption,
  type TripPaymentStatus,
  type TripEstimateBody,
  type TripRequestBody,
  type TripStatus,
  type TripSummary,
} from '@yatri/types';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { sqlIn } from '../../lib/sql';
import { HttpError } from '../../middleware/errorHandler';
import { endLiveCallForTrip } from '../calls/calls.service';
import { setDriverTrip } from '../availability/presence.state';
import { cancelAcceptedOffer, cancelOpenOffersForTrip } from '../dispatch/offers.repository';
import { calculateDistance } from '../location/location.service';
import {
  getActiveCategoryByCode,
  getCategoryById,
  listActiveCategories,
  pricingFor,
} from '../pricing/categories';
import { estimateFare, finalFare, waitingCharge } from '../pricing/pricing';
import { pricingConfig } from '../pricing/pricing.config';
import { settingBool, settingText } from '../settings/settings.service';
import { isCategoryAvailable } from '../dispatch/matching';
import { decidePassengerCancellation, requireCancellationAllowed } from './cancellation';
import { estimateEta } from '../tracking/eta';
import { trackingConfig } from '../tracking/tracking.config';
import { freshnessOf } from '../tracking/tracking.rules';
import {
  bumpTripVersion,
  getDriverFix,
  onTripStatusChanged,
  readOdometerMeters,
  saveMeta,
  type TripMeta,
} from '../tracking/tracking.service';
import { endSharesForTrip } from '../sharing/sharing.service';
import { freshProfilePictureUrl } from '../users/profile-picture';
import { approvedVehicleOf } from '../vehicles/vehicle-lookup';
import { requireParticipant } from './access';
import { secondsSince } from './waiting';
import { createPendingPayment } from './payments.service';
import { measuredRideDistance, rideDurationSeconds } from './ride-actuals';
import { ratingSummary } from './ratings.service';
import { recordTripEvent } from './trip-events.service';
import { statusesLeadingTo } from './trip-machine';
import {
  casTripStatus,
  createTripRequest,
  destinationOf,
  getTrip,
  pickupOf,
  type TripPatch,
  type TripRow,
} from './trips.repository';

export function metaFromRow(t: TripRow): TripMeta {
  return {
    tripId: t.id,
    status: t.status,
    passengerId: t.passenger_id,
    driverId: t.driver_id,
    pickup: pickupOf(t),
    destination: destinationOf(t),
    distanceMeters: t.distance_meters,
    matchedAtMs: t.matched_at?.getTime() ?? null,
    arrivedAtMs: t.arrived_at?.getTime() ?? null,
    passengerNotifiedAtMs: t.passenger_notified_at?.getTime() ?? null,
    driverNotifiedAtMs: null,
  };
}

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Trip not found.');

/** Non-participants get the same 404 as a missing trip: there is no way to probe other people's trips. */
export async function participantTrip(tripId: string, userId: string): Promise<TripRow> {
  return (await requireParticipant(tripId, userId)).trip;
}

// ------------------------------------------------------------------ the summary everyone reads

async function counterpartOf(
  t: TripRow,
  viewerIsPassenger: boolean,
): Promise<TripCounterpart | null> {
  const otherId = viewerIsPassenger ? t.driver_id : t.passenger_id;
  if (!otherId) return null;
  const u = await query<{ full_name: string | null; profile_picture_url: string | null }>(
    'SELECT full_name, profile_picture_url FROM users WHERE id = $1',
    [otherId],
  );
  const vehicle = viewerIsPassenger ? await approvedVehicleOf(otherId) : null;
  const rating = await ratingSummary(otherId);
  return {
    name: u.rows[0]?.full_name ?? null,
    vehicle,
    rating: rating.average,
    ratingCount: rating.count,
    // The passenger sees the driver's photo; the driver is only given the passenger's name.
    photoUrl: viewerIsPassenger
      ? await freshProfilePictureUrl(u.rows[0]?.profile_picture_url ?? null)
      : null,
  };
}

/** THE trip summary: built once, here, for whoever asks (passenger, driver, history). */
export async function buildTripSummary(t: TripRow, viewerId: string): Promise<TripSummary> {
  const viewerIsPassenger = t.passenger_id === viewerId;
  const [pay, rated, counterpart] = await Promise.all([
    query<{ status: TripPaymentStatus }>('SELECT status FROM trip_payments WHERE trip_id = $1', [
      t.id,
    ]),
    query('SELECT 1 FROM trip_ratings WHERE trip_id = $1 AND rater_id = $2', [t.id, viewerId]),
    counterpartOf(t, viewerIsPassenger),
  ]);
  return {
    id: t.id,
    status: t.status,
    pickup: pickupOf(t),
    destination: destinationOf(t),
    requestedAt: t.requested_at.toISOString(),
    matchedAt: t.matched_at?.toISOString() ?? null,
    arrivedAt: t.arrived_at?.toISOString() ?? null,
    startedAt: t.started_at?.toISOString() ?? null,
    endedAt: t.ended_at?.toISOString() ?? null,
    cancelReason: t.cancel_reason,
    cancelledBy: (t.cancelled_by as TripSummary['cancelledBy']) ?? null,
    fare:
      t.fare_estimate_npr === null
        ? null
        : {
            estimateNpr: t.fare_estimate_npr,
            waitingChargeNpr: t.waiting_charge_npr,
            finalNpr: t.fare_final_npr,
            distanceMeters: t.distance_meters ?? 0,
            actualDistanceMeters: t.actual_distance_meters,
            actualDurationSeconds: t.actual_duration_seconds,
          },
    counterpart,
    viewerRole: viewerIsPassenger ? 'PASSENGER' : 'DRIVER',
    paymentStatus: pay.rows[0]?.status ?? 'NONE',
    vehicleCategory:
      t.vehicle_category_code && t.vehicle_category_label
        ? { code: t.vehicle_category_code, label: t.vehicle_category_label }
        : null,
    // What cancelling would cost right now, from THE cancellation rules (passenger of a live ride only).
    cancelFeeNpr:
      viewerIsPassenger && !TERMINAL_TRIP_STATUSES.includes(t.status)
        ? decidePassengerCancellation({ status: t.status, matchedAt: t.matched_at }, new Date())
            .feeNpr
        : 0,
    cancellation:
      t.status === 'CANCELLED' && t.cancelled_from_status
        ? { fromStatus: t.cancelled_from_status, feeNpr: t.cancellation_fee_npr }
        : null,
    rated: !!rated.rowCount,
  };
}

// ------------------------------------------------------------------ fare estimate & request

const MIN_TRIP_METERS = 50;

/** The route, duration and distance for a trip: calculated by the server, never supplied by a client. */
async function measureTrip(body: TripEstimateBody) {
  const distance = haversineMeters(body.pickup, body.destination);
  if (distance < MIN_TRIP_METERS) {
    throw new HttpError(
      422,
      'PICKUP_EQUALS_DESTINATION',
      'Pickup and destination are too close together.',
    );
  }
  // Route-based when a routing engine is configured; a client-supplied distance does not exist.
  const d = await calculateDistance(body.pickup, body.destination, 'route');
  const durationSeconds = d.durationSeconds ?? estimateEta(d.distanceMeters).etaSeconds;
  return { distanceMeters: d.distanceMeters, durationSeconds, routeBased: d.method === 'route' };
}

const unknownCategory = () =>
  new HttpError(422, 'VEHICLE_CATEGORY_UNKNOWN', 'That vehicle type is not available.');

/**
 * The estimate for a request: the selected category's fare, plus every active category priced and
 * marked available-or-not near the pickup (a yes/no; no driver is ever identified or counted).
 */
export async function estimateForRequest(body: TripEstimateBody) {
  const trip = await measureTrip(body);
  const categories = await listActiveCategories();
  const selected = body.vehicleCategory
    ? categories.find((c) => c.code === body.vehicleCategory)
    : categories[0]; // no choice yet: price the first category; the picker lists them all
  if (!selected) throw unknownCategory();
  const options: RideCategoryOption[] = await Promise.all(
    categories.map(async (c) => ({
      code: c.code,
      label: c.label,
      available: await isCategoryAvailable(body.pickup, c.id),
      fare: estimateFare(trip, pricingFor(c)),
    })),
  );
  const chosen = options.find((o) => o.code === selected.code) as RideCategoryOption;
  return {
    fare: chosen.fare,
    category: selected,
    options,
    distanceMeters: trip.distanceMeters,
    durationSeconds: trip.durationSeconds,
  };
}

export async function requestTrip(passengerId: string, body: TripRequestBody): Promise<TripRow> {
  // Operations can pause new requests (an outage, an incident); rides under way carry on.
  if (!settingBool('SERVICE_REQUESTS_ENABLED')) {
    throw new HttpError(503, 'SERVICE_PAUSED', settingText('SERVICE_PAUSED_MESSAGE'));
  }
  const category = await getActiveCategoryByCode(body.vehicleCategory);
  if (!category) throw unknownCategory();
  const trip = await measureTrip(body);
  // The fare is priced by the server for the chosen category; the request carries no price.
  const fare = estimateFare(trip, pricingFor(category));
  // Availability is informational (the picker shows it). A request with nobody nearby still
  // searches: drivers come online, and the search ends in NO_DRIVERS on its own deadline.
  let row: TripRow;
  try {
    row = await createTripRequest({
      passengerId,
      vehicleCategoryId: category.id,
      pickup: {
        latitude: body.pickup.latitude,
        longitude: body.pickup.longitude,
        address: body.pickup.address,
        placeName: body.pickup.name ?? null,
      },
      destination: {
        latitude: body.destination.latitude,
        longitude: body.destination.longitude,
        address: body.destination.address,
        placeName: body.destination.name ?? null,
      },
      distanceMeters: trip.distanceMeters,
      durationSeconds: trip.durationSeconds,
      fareEstimateNpr: fare.totalNpr,
      searchTimeoutSeconds: env.DISPATCH_SEARCH_TIMEOUT_SECONDS,
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'TRIP_ALREADY_ACTIVE', 'You already have a ride in progress.');
    }
    throw err;
  }
  await saveMeta(metaFromRow(row));
  await bumpTripVersion(row.id);
  await recordTripEvent({ tripId: row.id, type: 'TRIP_REQUESTED', actorId: passengerId });
  return row;
}

// ------------------------------------------------------------------ transitions (the one path)

interface TransitionSpec {
  to: TripStatus;
  patch?: TripPatch;
  expectDriverId?: string;
  event: { type: TripEventType; actorId?: string; payload?: TripEventPayload };
  /** Override the allowed source statuses (defaults to every status the machine allows). */
  from?: readonly TripStatus[];
}

/** CAS the status, refresh the shared state, then record the ONE event describing it. */
async function transition(tripId: string, spec: TransitionSpec): Promise<TripRow> {
  const from = spec.from ?? statusesLeadingTo(spec.to);
  const before = await getTrip(tripId);
  const updated = await casTripStatus(tripId, from, spec.to, spec.patch, spec.expectDriverId);
  if (!updated) {
    throw new HttpError(409, 'INVALID_STATE_TRANSITION', 'The ride cannot move to that state now.');
  }
  await onTripStatusChanged(metaFromRow(updated));
  // The driver's presence connection feeds exactly the trip they are assigned to.
  const driverId = updated.driver_id ?? before?.driver_id ?? null;
  if (driverId) {
    const assigned =
      spec.to === 'DRIVER_EN_ROUTE' || spec.to === 'DRIVER_ARRIVED' || spec.to === 'IN_PROGRESS';
    await setDriverTrip(driverId, assigned ? tripId : null);
  }
  // A call cannot outlive the assignment it belongs to.
  if (spec.to !== 'DRIVER_ARRIVED' && spec.to !== 'IN_PROGRESS' && spec.to !== 'DRIVER_EN_ROUTE') {
    await endLiveCallForTrip(tripId);
  }
  // Cancellations and re-matches record the state they left, alongside who/why/when (the event's
  // actor, payload and timestamp): the complete, authoritative record of a cancellation.
  const leftFrom =
    before && (spec.to === 'CANCELLED' || spec.event.type === 'DRIVER_REMATCHING')
      ? { fromStatus: before.status }
      : {};
  await recordTripEvent({ tripId, ...spec.event, payload: { ...spec.event.payload, ...leftFrom } });
  // When the ride is over, every trip-sharing link stops sharing.
  if (TERMINAL_TRIP_STATUSES.includes(spec.to)) await endSharesForTrip(tripId);
  return updated;
}

/** Called by dispatch when a driver accepts. */
export async function assignDriver(tripId: string, driverId: string): Promise<TripRow> {
  return transition(tripId, {
    to: 'DRIVER_EN_ROUTE',
    from: ['SEARCHING'],
    patch: { driverId, matchedAt: 'now' },
    event: { type: 'DRIVER_ASSIGNED', actorId: driverId },
  });
}

export async function markNoDrivers(tripId: string): Promise<TripRow | null> {
  try {
    return await transition(tripId, {
      to: 'NO_DRIVERS',
      from: ['SEARCHING'],
      event: { type: 'NO_DRIVERS_FOUND' },
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) return null; // someone else resolved it first
    throw err;
  }
}

export async function driverArrived(tripId: string, driverId: string): Promise<TripRow> {
  const trip = await getTrip(tripId);
  if (!trip || trip.driver_id !== driverId) throw notFound();
  // The server checks the driver really is at the pickup: "arrived" is not taken on faith.
  const fix = await getDriverFix(tripId);
  const pickup = pickupOf(trip);
  if (!fix || haversineMeters(fix, pickup) > env.TRIP_ARRIVAL_RADIUS_METERS) {
    throw new HttpError(
      409,
      'NOT_AT_PICKUP',
      `You need to be within ${env.TRIP_ARRIVAL_RADIUS_METERS} meters of the pickup to mark arrival.`,
    );
  }
  return transition(tripId, {
    to: 'DRIVER_ARRIVED',
    from: ['DRIVER_EN_ROUTE'],
    expectDriverId: driverId,
    patch: { arrivedAt: 'now', passengerNotifiedAt: 'now' },
    event: { type: 'DRIVER_ARRIVED', actorId: driverId },
  });
}

/**
 * The driver's last accepted position, required to start or finish a ride: the ride's start and end
 * are recorded from what the SERVER saw, never from a coordinate a client sends with the request.
 */
async function requireDriverFix(tripId: string) {
  const fix = await getDriverFix(tripId);
  if (!fix || freshnessOf(fix.receivedAtMs, Date.now(), trackingConfig()) === 'lost') {
    throw new HttpError(
      409,
      'LOCATION_UNAVAILABLE',
      'We cannot see your location right now. Check that location sharing is on, then try again.',
    );
  }
  return fix;
}

export async function startTrip(tripId: string, driverId: string): Promise<TripRow> {
  const trip = await getTrip(tripId);
  if (!trip || trip.driver_id !== driverId) throw notFound();
  const at = await requireDriverFix(tripId);
  // Waiting is priced once, from server timestamps, at the moment the ride starts.
  const waitedSeconds = trip.arrived_at ? secondsSince(trip.arrived_at.getTime(), Date.now()) : 0;
  const { chargeNpr } = waitingCharge(waitedSeconds, pricingConfig());
  return transition(tripId, {
    to: 'IN_PROGRESS',
    from: ['DRIVER_ARRIVED'],
    expectDriverId: driverId,
    patch: {
      startedAt: 'now',
      waitingChargeNpr: chargeNpr,
      startedLatitude: at.latitude,
      startedLongitude: at.longitude,
    },
    event: {
      type: 'TRIP_STARTED',
      actorId: driverId,
      payload: { waitedSeconds: Math.round(waitedSeconds), waitingChargeNpr: chargeNpr },
    },
  });
}

/**
 * Finish the ride. The final fare is the one fare service applied to what the ride ACTUALLY measured
 * (distance driven, time taken) plus the waiting charge fixed at the start; the estimate is left as it was.
 */
export async function completeTrip(tripId: string, driverId: string): Promise<TripRow> {
  const trip = await getTrip(tripId);
  if (!trip || trip.driver_id !== driverId) throw notFound();
  const end = await requireDriverFix(tripId);
  // Read before the transition: ending the ride clears the live state the odometer lives in.
  const odometer = await readOdometerMeters(tripId);
  const start =
    trip.started_latitude !== null && trip.started_longitude !== null
      ? { latitude: Number(trip.started_latitude), longitude: Number(trip.started_longitude) }
      : null;
  const distanceMeters = measuredRideDistance(odometer, start, end);
  const durationSeconds = rideDurationSeconds(trip.started_at, Date.now());
  const category = trip.vehicle_category_id
    ? await getCategoryById(trip.vehicle_category_id)
    : null;
  const { totalNpr: finalNpr } = finalFare(
    { distanceMeters, durationSeconds },
    pricingFor(category),
    trip.waiting_charge_npr,
  );
  const done = await transition(tripId, {
    to: 'COMPLETED',
    from: ['IN_PROGRESS'],
    expectDriverId: driverId,
    patch: {
      endedAt: 'now',
      fareFinalNpr: finalNpr,
      endedLatitude: end.latitude,
      endedLongitude: end.longitude,
      actualDistanceMeters: distanceMeters,
      actualDurationSeconds: durationSeconds,
    },
    event: {
      type: 'TRIP_COMPLETED',
      actorId: driverId,
      payload: { fareNpr: finalNpr, distanceMeters, durationSeconds },
    },
  });
  await createPendingPayment(tripId, finalNpr);
  return done;
}

export interface CancelOutcome {
  trip: TripRow;
  /** True when the trip went back to SEARCHING and needs the dispatcher to find another driver. */
  rematching: boolean;
}

export async function passengerCancel(
  tripId: string,
  passengerId: string,
  reason?: string,
): Promise<CancelOutcome> {
  const trip = await getTrip(tripId);
  if (!trip || trip.passenger_id !== passengerId) throw notFound();
  // THE cancellation rules decide whether this is allowed and what it costs (cancellation.ts).
  const feeNpr = requireCancellationAllowed(
    decidePassengerCancellation({ status: trip.status, matchedAt: trip.matched_at }, new Date()),
  );
  const cancelled = await transition(tripId, {
    to: 'CANCELLED',
    from: ['SEARCHING', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'],
    patch: {
      endedAt: 'now',
      cancelledBy: 'PASSENGER',
      cancelReason: reason ?? null,
      cancellationFeeNpr: feeNpr,
    },
    event: {
      type: 'TRIP_CANCELLED',
      actorId: passengerId,
      payload: { by: 'PASSENGER', reason: reason ?? null, feeNpr },
    },
  });
  await cancelOpenOffersForTrip(tripId);
  return { trip: cancelled, rematching: false };
}

/** The driver drops out before pickup: the trip is not cancelled, it goes back to be re-matched. */
export async function driverDropsOut(
  tripId: string,
  driverId: string,
  reason: 'DRIVER_CANCELLED' | 'DRIVER_LOST',
): Promise<CancelOutcome> {
  const trip = await getTrip(tripId);
  if (!trip || trip.driver_id !== driverId) throw notFound();
  if (trip.status === 'IN_PROGRESS') {
    throw new HttpError(
      409,
      'CANNOT_CANCEL_IN_PROGRESS',
      'Complete the ride, or contact support if there is a problem.',
    );
  }
  const back = await transition(tripId, {
    to: 'SEARCHING',
    from: ['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'],
    expectDriverId: driverId,
    patch: {
      driverId: null,
      matchedAt: null,
      arrivedAt: null,
      searchDeadlineSeconds: env.DISPATCH_SEARCH_TIMEOUT_SECONDS,
    },
    event: { type: 'DRIVER_REMATCHING', actorId: driverId, payload: { reason } },
  });
  await cancelAcceptedOffer(tripId, driverId);
  await setDriverTrip(driverId, null);
  return { trip: back, rematching: true };
}

/** A waiting driver may cancel as a no-show once the configured wait has passed. */
export async function driverNoShow(tripId: string, driverId: string): Promise<TripRow> {
  const trip = await getTrip(tripId);
  if (!trip || trip.driver_id !== driverId) throw notFound();
  const cfg = pricingConfig();
  const waited = trip.arrived_at ? secondsSince(trip.arrived_at.getTime(), Date.now()) : 0;
  if (trip.status !== 'DRIVER_ARRIVED' || waited < cfg.noShowAfterSeconds) {
    throw new HttpError(
      409,
      'NO_SHOW_TOO_EARLY',
      `You can report a no-show after waiting ${Math.round(cfg.noShowAfterSeconds / 60)} minutes.`,
    );
  }
  return transition(tripId, {
    to: 'CANCELLED',
    from: ['DRIVER_ARRIVED'],
    expectDriverId: driverId,
    patch: { endedAt: 'now', cancelledBy: 'DRIVER', cancelReason: 'PASSENGER_NO_SHOW' },
    event: {
      type: 'TRIP_CANCELLED',
      actorId: driverId,
      payload: { by: 'DRIVER', reason: 'The passenger did not arrive' },
    },
  });
}

/** Operator override (disputes, stuck trips). Recorded with the admin as actor. */
export async function adminCancelTrip(
  tripId: string,
  adminId: string,
  reason: string,
): Promise<TripRow> {
  const cancelled = await transition(tripId, {
    to: 'CANCELLED',
    from: ['SEARCHING', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
    patch: { endedAt: 'now', cancelledBy: 'SYSTEM', cancelReason: reason },
    event: { type: 'TRIP_CANCELLED', actorId: adminId, payload: { by: 'SYSTEM', reason } },
  });
  await cancelOpenOffersForTrip(tripId);
  return cancelled;
}

// ------------------------------------------------------------------ history

const TERMINAL_SQL = sqlIn(TERMINAL_TRIP_STATUSES);

export async function listHistory(userId: string, page: number, pageSize: number) {
  const rows = await query<{ id: string }>(
    `SELECT id FROM trips
     WHERE (passenger_id = $1 OR driver_id = $1) AND status IN ${TERMINAL_SQL}
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, pageSize, (page - 1) * pageSize],
  );
  const total = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM trips
     WHERE (passenger_id = $1 OR driver_id = $1) AND status IN ${TERMINAL_SQL}`,
    [userId],
  );
  const items = await Promise.all(
    rows.rows.map(async (r) => buildTripSummary((await getTrip(r.id)) as TripRow, userId)),
  );
  return { items, total: Number(total.rows[0]?.n ?? 0) };
}
