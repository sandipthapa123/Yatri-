import { z } from 'zod';

import { latitudeSchema, longitudeSchema } from '../location/coordinates';

// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const text = (max: number) =>
  z.string().trim().min(1).max(max).regex(NO_CONTROL, 'Contains invalid characters');
const optionalText = (max: number) => z.union([text(max), z.null()]).optional();

const kind = z.enum(['HOME', 'WORK', 'FAVOURITE']);

const notNullIsland = (c: { latitude?: number; longitude?: number }) =>
  !(c.latitude === 0 && c.longitude === 0);

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
  .refine(notNullIsland, {
    message: 'Coordinates 0,0 are not a valid location',
    path: ['latitude'],
  });

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
  .refine(notNullIsland, {
    message: 'Coordinates 0,0 are not a valid location',
    path: ['latitude'],
  });
