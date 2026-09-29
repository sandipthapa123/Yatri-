import { isNullIsland } from '@yatri/types';
import { z } from 'zod';

const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * Accepts a JSON number or a plain decimal string (query params arrive as
 * strings). Deliberately does NOT use z.coerce.number(): Number("") and
 * Number(null) are 0, which would turn a missing coordinate into a valid
 * point in the Gulf of Guinea. NaN, Infinity, hex, exponent and blank input
 * are all rejected, and the range is enforced here — never trusted from the client.
 */
function boundedDegrees(name: string, limit: number) {
  return z
    .union(
      [z.number(), z.string().trim().regex(NUMERIC_STRING, `${name} must be a decimal number`)],
      { error: `${name} is required and must be a number` },
    )
    .transform((v) => (typeof v === 'string' ? Number(v) : v))
    .refine((v) => Number.isFinite(v), { message: `${name} must be a finite number` })
    .refine((v) => v >= -limit && v <= limit, {
      message: `${name} must be between -${limit} and ${limit}`,
    });
}

export const latitudeSchema = boundedDegrees('latitude', 90);
export const longitudeSchema = boundedDegrees('longitude', 180);

/**
 * (0, 0) is what many GPS stacks report when they have no fix at all; treat it as invalid.
 * Use `.refine(notNullIsland, NULL_ISLAND_ISSUE)` on any lat/lng object so every schema shares one rule.
 */
export const notNullIsland = (c: { latitude?: number; longitude?: number }) => !isNullIsland(c);
export const NULL_ISLAND_ISSUE = {
  message: 'Coordinates 0,0 are not a valid location',
  path: ['latitude'],
};

export const coordinateSchema = z
  .object({ latitude: latitudeSchema, longitude: longitudeSchema })
  .refine(notNullIsland, NULL_ISLAND_ISSUE);

export type Coordinate = z.infer<typeof coordinateSchema>;

/** Round to the precision we store (7 decimals ≈ 1 cm). */
export function roundCoordinate(value: number, decimals = 7): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
