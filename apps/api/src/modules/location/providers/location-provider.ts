import type { PlaceSummary, ReverseGeocodeResult } from '@yatri/types';

import type { Coordinate } from '../coordinates';

export interface SearchOptions {
  limit: number;
  /** Optional bias point (already coarsened by the caller); results are NOT restricted to it. */
  near?: Coordinate;
}

/**
 * The only surface the rest of Yatri uses for geocoding. Implementations
 * live in this folder and return already-normalized results — no provider
 * field names leak past this boundary. Swapping map vendors means adding a
 * class here and a case in providers/index.ts.
 */
export interface LocationProvider {
  readonly name: string;
  /** Free-text -> best matches (place names, addresses, landmarks; English or Nepali). */
  search(query: string, options: SearchOptions): Promise<PlaceSummary[]>;
  /** Free-text -> single best match, or null. */
  geocode(query: string): Promise<PlaceSummary | null>;
  /** Coordinates -> human-readable place, or null when nothing is known there. */
  reverseGeocode(point: Coordinate): Promise<ReverseGeocodeResult | null>;
}

export type ProviderFailureKind =
  'UNAVAILABLE' | 'TIMEOUT' | 'RATE_LIMITED' | 'QUOTA' | 'BAD_RESPONSE';

/** Internal error type; the service maps it to a safe HttpError. Its message is never sent to clients. */
export class LocationProviderError extends Error {
  constructor(
    public readonly kind: ProviderFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'LocationProviderError';
  }
}
