import { pageParam, pageSizeParam } from '../../lib/pagination';
import { DRIVER_AVAILABILITY_STATES, DRIVER_STATUSES } from '@yatri/types';
import { z } from 'zod';

import {
  latitudeSchema,
  longitudeSchema,
  notNullIsland,
  NULL_ISLAND_ISSUE,
} from '../location/coordinates';

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

export const driverLocationSampleSchema = z
  .object(driverLocationSampleShape)
  .strict()
  .refine(notNullIsland, NULL_ISLAND_ISSUE);

export const adminAvailabilityQuerySchema = z.object({
  state: z.enum(DRIVER_AVAILABILITY_STATES).optional(),
  freshness: z.enum(['fresh', 'stale', 'none']).optional(),
  verification: z.enum(DRIVER_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  page: pageParam,
  pageSize: pageSizeParam(50, 20),
});
