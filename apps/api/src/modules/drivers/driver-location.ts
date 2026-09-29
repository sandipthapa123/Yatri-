import type { Request, Response } from 'express';
import type { ApiResponse, DriverLocation } from '@yatri/types';
import { z } from 'zod';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { coordinateSchema } from '../location/coordinates';

/**
 * Explicit, one-shot "here is my position" for the signed-in driver. Stores
 * only the LAST known position (one row, overwritten) — no history, no
 * continuous stream. Never readable by passengers; live tracking is a later phase.
 */
export const driverLocationSchema = z
  .object({
    latitude: z.unknown(),
    longitude: z.unknown(),
    accuracyMeters: z.number().finite().min(0).max(100_000).nullable().optional(),
  })
  .strict()
  .transform((body, ctx) => {
    const parsed = coordinateSchema.safeParse({
      latitude: body.latitude,
      longitude: body.longitude,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
      return z.NEVER;
    }
    return { ...parsed.data, accuracyMeters: body.accuracyMeters ?? null };
  });

interface Row {
  latitude: string;
  longitude: string;
  accuracy_meters: number | null;
  recorded_at: Date;
}

function toLocation(r: Row): DriverLocation {
  return {
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    accuracyMeters: r.accuracy_meters,
    recordedAt: r.recorded_at.toISOString(),
  };
}

function driverId(req: Request): string {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
}

export async function putLocationHandler(req: Request, res: Response<ApiResponse<DriverLocation>>) {
  const b = req.body as { latitude: number; longitude: number; accuracyMeters: number | null };
  // recorded_at is the server's clock: a client-supplied timestamp is never trusted.
  const result = await query<Row>(
    `INSERT INTO driver_last_locations (driver_id, latitude, longitude, accuracy_meters, recorded_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (driver_id) DO UPDATE SET
       latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
       accuracy_meters = EXCLUDED.accuracy_meters, recorded_at = EXCLUDED.recorded_at
     RETURNING latitude, longitude, accuracy_meters, recorded_at`,
    [driverId(req), b.latitude, b.longitude, b.accuracyMeters],
  );
  res.json({ success: true, data: toLocation(result.rows[0] as Row) });
}

export async function getLocationHandler(req: Request, res: Response<ApiResponse<DriverLocation>>) {
  const result = await query<Row>(
    `SELECT latitude, longitude, accuracy_meters, recorded_at
     FROM driver_last_locations WHERE driver_id = $1`,
    [driverId(req)],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'No location has been shared yet.');
  res.json({ success: true, data: toLocation(row) });
}

export async function deleteLocationHandler(
  req: Request,
  res: Response<ApiResponse<{ cleared: true }>>,
) {
  await query('DELETE FROM driver_last_locations WHERE driver_id = $1', [driverId(req)]);
  res.json({ success: true, data: { cleared: true } });
}
