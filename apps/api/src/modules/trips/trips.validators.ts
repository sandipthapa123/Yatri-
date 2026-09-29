import { DISPUTE_REASON_MAX, RATING_COMMENT_MAX, RATING_MAX, RATING_MIN } from '@yatri/types';
import { z } from 'zod';

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
export const tripRequestSchema = z.object({ pickup: place, destination: place }).strict();

export const cancelSchema = z
  .object({ reason: z.string().trim().min(1).max(200).optional() })
  .strict();

export const ratingSchema = z
  .object({
    stars: z.number().int().min(RATING_MIN).max(RATING_MAX),
    comment: z.string().trim().max(RATING_COMMENT_MAX).nullable().optional(),
  })
  .strict();

export const disputeSchema = z
  .object({ reason: z.string().trim().min(5).max(DISPUTE_REASON_MAX) })
  .strict();

export const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
});
