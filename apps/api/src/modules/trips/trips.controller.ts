import type { Request, Response } from 'express';
import type { ApiResponse, LiveTripSnapshot, TripSummary } from '@yatri/types';
import { z } from 'zod';

import { HttpError } from '../../middleware/errorHandler';
import { latitudeSchema, longitudeSchema } from '../location/coordinates';
import { buildSnapshot, isActive, loadMeta } from '../tracking/tracking.service';
import { getActiveTripFor, getTrip, toTripSummary, type TripRow } from './trips.repository';
import { changeTripStatus, createTripForParticipants, metaFromRow } from './trips.service';

function uid(req: Request): string {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
}
const idParam = (req: Request) => {
  const v = req.params.id;
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

/** Only a trip's own passenger or driver may see it; everyone else gets a plain 404. */
async function participantTrip(req: Request): Promise<TripRow> {
  const trip = await getTrip(idParam(req));
  const me = uid(req);
  if (!trip || (trip.passenger_id !== me && trip.driver_id !== me)) {
    throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
  }
  return trip;
}

export async function activeTripHandler(
  req: Request,
  res: Response<ApiResponse<TripSummary | null>>,
) {
  const trip = await getActiveTripFor(uid(req));
  res.json({ success: true, data: trip ? toTripSummary(trip, uid(req)) : null });
}

export async function getTripHandler(req: Request, res: Response<ApiResponse<TripSummary>>) {
  res.json({ success: true, data: toTripSummary(await participantTrip(req), uid(req)) });
}

/** REST snapshot: the initial paint and the fallback when the socket is down. Not a history endpoint. */
export async function liveSnapshotHandler(
  req: Request,
  res: Response<ApiResponse<LiveTripSnapshot>>,
) {
  const trip = await participantTrip(req);
  if (!isActive(trip.status)) {
    throw new HttpError(
      409,
      'TRIP_NOT_ACTIVE',
      'Live location is only available during an active trip.',
    );
  }
  const meta = (await loadMeta(trip.id)) ?? metaFromRow(trip);
  const viewer = trip.passenger_id === uid(req) ? 'PASSENGER' : 'DRIVER';
  res.json({ success: true, data: await buildSnapshot(meta, viewer) });
}

export function statusHandler(action: 'arrived' | 'start' | 'complete' | 'cancel') {
  return async (req: Request, res: Response<ApiResponse<TripSummary>>) => {
    const row = await changeTripStatus(idParam(req), uid(req), action);
    res.json({ success: true, data: toTripSummary(row, uid(req)) });
  };
}

const placeSchema = z
  .object({
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    address: z.string().trim().min(1).max(300),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .refine((p) => !(p.latitude === 0 && p.longitude === 0), {
    message: 'Coordinates 0,0 are not a valid location',
    path: ['latitude'],
  });

export const createTripSchema = z.object({
  passengerId: z.string().uuid(),
  driverId: z.string().uuid(),
  pickup: placeSchema,
  destination: placeSchema,
});

export async function adminCreateTripHandler(
  req: Request,
  res: Response<ApiResponse<TripSummary>>,
) {
  const b = req.body as z.infer<typeof createTripSchema>;
  const row = await createTripForParticipants({
    passengerId: b.passengerId,
    driverId: b.driverId,
    pickup: {
      latitude: b.pickup.latitude,
      longitude: b.pickup.longitude,
      address: b.pickup.address,
      placeName: b.pickup.name ?? null,
    },
    destination: {
      latitude: b.destination.latitude,
      longitude: b.destination.longitude,
      address: b.destination.address,
      placeName: b.destination.name ?? null,
    },
  });
  res.status(201).json({ success: true, data: toTripSummary(row, b.passengerId) });
}
