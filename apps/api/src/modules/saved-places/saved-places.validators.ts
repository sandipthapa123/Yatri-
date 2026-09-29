import { z } from 'zod';

import {
  latitudeSchema,
  longitudeSchema,
  notNullIsland,
  NULL_ISLAND_ISSUE,
} from '../location/coordinates';

// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const text = (max: number) =>
  z.string().trim().min(1).max(max).regex(NO_CONTROL, 'Contains invalid characters');
const optionalText = (max: number) => z.union([text(max), z.null()]).optional();

const kind = z.enum(['HOME', 'WORK', 'FAVOURITE']);

export const createSavedPlaceSchema = z
  .object({
    kind,
    name: text(80),
    label: optionalText(80),
    // Display text only. When omitted the server reverse-geocodes; coordinates are the source of truth.
    address: text(300).optional(),
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    city: optionalText(120),
    province: optionalText(120),
    country: optionalText(120),
  })
  .strict()
  .refine(notNullIsland, NULL_ISLAND_ISSUE);

export const updateSavedPlaceSchema = z
  .object({
    kind: kind.optional(),
    name: text(80).optional(),
    label: optionalText(80),
    address: text(300).optional(),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    city: optionalText(120),
    province: optionalText(120),
    country: optionalText(120),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided.' })
  .refine((d) => (d.latitude === undefined) === (d.longitude === undefined), {
    message: 'latitude and longitude must be provided together',
    path: ['latitude'],
  })
  .refine(notNullIsland, NULL_ISLAND_ISSUE);
