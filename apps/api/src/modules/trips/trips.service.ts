import type { TripEventName, TripStatus } from '@yatri/types';

import { HttpError } from '../../middleware/errorHandler';
import { query } from '../../lib/db';
import { getLocationProvider } from '../location/providers';
import type { LocationFields } from '../location/locations.repository';
import {
  destinationOf,
  getTrip,
  pickupOf,
  transitionTrip,
  createTrip,
  type TripRow,
} from './trips.repository';
import { onTripStatusChanged, saveMeta, type TripMeta } from '../tracking/tracking.service';
import { publishTripChange } from '../realtime/bus';
import { getRedisClient } from '../../config/redis';

export function metaFromRow(t: TripRow): TripMeta {
  return {
    tripId: t.id,
    status: t.status,
    passengerId: t.passenger_id,
    driverId: t.driver_id,
    pickup: pickupOf(t),
    destination: destinationOf(t),
    arrivedAtMs: t.arrived_at?.getTime() ?? null,
  };
}

/**
 * Admin/test trip creation. Ride requests and matching are a later phase;
 * until then this is the only way a trip (and therefore live tracking)
 * comes into being, and it is restricted to admins.
 */
export async function createTripForParticipants(input: {
  passengerId: string;
  driverId: string;
  pickup: LocationFields;
  destination: LocationFields;
}): Promise<TripRow> {
  const roles = await query<{ id: string; role: string; status: string }>(
    'SELECT id, role, status FROM users WHERE id = ANY($1::uuid[])',
    [[input.passengerId, input.driverId]],
  );
  const passenger = roles.rows.find((r) => r.id === input.passengerId);
  const driver = roles.rows.find((r) => r.id === input.driverId);
  if (passenger?.role !== 'PASSENGER' || driver?.role !== 'DRIVER') {
    throw new HttpError(
      422,
      'INVALID_PARTICIPANTS',
      'Trip needs an existing passenger and driver.',
    );
  }
  const provider = getLocationProvider()?.name ?? 'none';
  let row: TripRow;
  try {
    row = await createTrip({
      ...input,
      pickup: { ...input.pickup, provider },
      destination: { ...input.destination, provider },
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(
        409,
        'TRIP_ALREADY_ACTIVE',
        'The passenger or driver is already on an active trip.',
      );
    }
    throw err;
  }
  await saveMeta(metaFromRow(row));
  await getRedisClient().expire(`trk:${row.id}:seq`, 6 * 3600);
  await publishTripChange({ tripId: row.id, eventId: 0 });
  return row;
}

const RULES: Record<
  'arrived' | 'start' | 'complete' | 'cancel',
  { from: TripStatus[]; to: TripStatus; event: TripEventName; who: 'driver' | 'either' }
> = {
  arrived: {
    from: ['DRIVER_EN_ROUTE'],
    to: 'DRIVER_ARRIVED',
    event: 'DRIVER_ARRIVED',
    who: 'driver',
  },
  start: { from: ['DRIVER_ARRIVED'], to: 'IN_PROGRESS', event: 'TRIP_STARTED', who: 'driver' },
  complete: { from: ['IN_PROGRESS'], to: 'COMPLETED', event: 'TRIP_COMPLETED', who: 'driver' },
  cancel: {
    from: ['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
    to: 'CANCELLED',
    event: 'TRIP_CANCELLED',
    who: 'either',
  },
};

export async function changeTripStatus(
  tripId: string,
  actorId: string,
  action: keyof typeof RULES,
): Promise<TripRow> {
  const trip = await getTrip(tripId);
  // Non-participants get the same 404 as a missing trip: no existence oracle.
  if (!trip || (trip.passenger_id !== actorId && trip.driver_id !== actorId)) {
    throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
  }
  const rule = RULES[action];
  if (rule.who === 'driver' && trip.driver_id !== actorId) {
    throw new HttpError(403, 'FORBIDDEN', 'Only the driver can do this.');
  }
  const updated = await transitionTrip(tripId, rule.from, rule.to, {
    cancelledBy: trip.driver_id === actorId ? 'DRIVER' : 'PASSENGER',
  });
  if (!updated) {
    throw new HttpError(409, 'INVALID_STATE_TRANSITION', 'The trip cannot move to that state now.');
  }
  await onTripStatusChanged(metaFromRow(updated), rule.event);
  return updated;
}
