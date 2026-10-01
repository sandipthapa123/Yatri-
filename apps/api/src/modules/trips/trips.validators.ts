import { RATING_COMMENT_MAX, RATING_MAX, RATING_MIN } from '@yatri/types';
import { z } from 'zod';

import { accessibilityRequestSchema } from '../accessibility/accessibility.validators';

import {
  latitudeSchema,
  longitudeSchema,
  notNullIsland,
  NULL_ISLAND_ISSUE,
} from '../location/coordinates';

const place = z
  .object({
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    address: z.string().trim().min(1).max(300),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine(notNullIsland, NULL_ISLAND_ISSUE);

/** No distance, fare or ETA field exists: the server calculates every one of them. */
const categoryCode = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Z0-9_]+$/);

export const tripRequestSchema = z
  .object({
    pickup: place,
    destination: place,
    vehicleCategory: categoryCode,
    confirmedTotalNpr: z.number().int().positive().max(1_000_000).optional(),
    accessibility: accessibilityRequestSchema.optional(),
  })
  .strict();

/** The estimate may leave the category out; the response then lists every category. */
export const tripEstimateSchema = z
  .object({
    pickup: place,
    destination: place,
    vehicleCategory: categoryCode.optional(),
    accessibility: accessibilityRequestSchema.optional(),
  })
  .strict();

export const cancelSchema = z
  .object({ reason: z.string().trim().min(1).max(200).optional() })
  .strict();

export const ratingSchema = z
  .object({
    stars: z.number().int().min(RATING_MIN).max(RATING_MAX),
    comment: z.string().trim().max(RATING_COMMENT_MAX).nullable().optional(),
  })
  .strict();

export const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/** The version of the route the app already holds, so an unchanged route is not sent again. */
export const navigationQuerySchema = z.object({
  version: z.coerce.number().int().min(0).optional(),
});

export const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
});
