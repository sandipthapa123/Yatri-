import { z } from 'zod';

import { latitudeSchema, longitudeSchema } from '../location/coordinates';

/**
 * One GPS reading from a driver device. `.strict()`: unknown keys — including any
 * attempt to smuggle in a `driverId` — are rejected, not ignored. The driver is always
 * identified by the authenticated session.
 */
export const driverLocationSampleShape = {
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracyMeters: z.number().finite().min(0).max(100_000).nullable().optional(),
  headingDegrees: z.number().finite().min(0).max(360).nullable().optional(),
  speedMps: z.number().finite().min(0).max(200).nullable().optional(),
  deviceTimeMs: z.number().finite().positive(),
  mockLocation: z.boolean().optional(),
};

const notNullIsland = (s: { latitude: number; longitude: number }) =>
  !(s.latitude === 0 && s.longitude === 0);

export const driverLocationSampleSchema = z
  .object(driverLocationSampleShape)
  .strict()
  .refine(notNullIsland, {
    message: 'Coordinates 0,0 are not a valid location',
    path: ['latitude'],
  });

export const adminAvailabilityQuerySchema = z.object({
  state: z
    .enum(['OFFLINE', 'GOING_ONLINE', 'ONLINE', 'GOING_OFFLINE', 'SUSPENDED', 'UNAVAILABLE'])
    .optional(),
  freshness: z.enum(['fresh', 'stale', 'none']).optional(),
  verification: z
    .enum([
      'NOT_STARTED',
      'IN_PROGRESS',
      'SUBMITTED',
      'UNDER_REVIEW',
      'VERIFIED',
      'REJECTED',
      'SUSPENDED',
    ])
    .optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
