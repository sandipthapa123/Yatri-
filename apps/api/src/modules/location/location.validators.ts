import { pageSizeParam } from '../../lib/pagination';
import { z } from 'zod';

import { coordinateSchema, latitudeSchema, longitudeSchema } from './coordinates';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const searchQuerySchema = z
  .object({
    q: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => [...s].length >= 2, { message: 'Enter at least 2 characters' })
      .refine((s) => [...s].length <= 100, { message: 'Search text is too long' })
      .refine((s) => !CONTROL_CHARS.test(s), { message: 'Search text has invalid characters' }),
    limit: pageSizeParam(10, 5),
    // Optional coarse bias point. Both or neither.
    nearLatitude: latitudeSchema.optional(),
    nearLongitude: longitudeSchema.optional(),
  })
  .refine((d) => (d.nearLatitude === undefined) === (d.nearLongitude === undefined), {
    message: 'nearLatitude and nearLongitude must be provided together',
    path: ['nearLatitude'],
  });

export const reverseQuerySchema = coordinateSchema;

export const distanceBodySchema = z.object({
  origin: coordinateSchema,
  destination: coordinateSchema,
  method: z.enum(['straight_line', 'route']).default('straight_line'),
});
