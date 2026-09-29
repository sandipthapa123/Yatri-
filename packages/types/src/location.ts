/**
 * Location domain types shared by the API and the mobile apps. Coordinates
 * are always WGS84 decimal degrees. Provider-specific fields never appear
 * here — clients only see these normalized shapes.
 */

export interface PlaceSummary {
  /** Primary label, e.g. "Thamel". */
  name: string;
  /** Secondary line that lets a user tell similar places apart, e.g. "Kathmandu, Bagmati Province". */
  address: string;
  latitude: number;
  longitude: number;
  city: string | null;
  province: string | null;
  country: string | null;
  postalCode: string | null;
  /** Whether the place is a street/road or a named place; lets spoken text say "on New Road" vs "near Thamel". */
  kind?: 'road' | 'place';
}

export interface ReverseGeocodeResult extends PlaceSummary {
  /** Full one-line address, e.g. "Thamel, Kathmandu, Bagmati Province, Nepal". */
  formattedAddress: string;
}

export interface DistanceResult {
  distanceMeters: number;
  distanceKm: number;
  /** How the distance was derived. `straight_line` is great-circle, not road distance. */
  method: 'straight_line' | 'route';
  durationSeconds: number | null;
}

export type SavedPlaceKind = 'HOME' | 'WORK' | 'FAVOURITE';

export interface SavedPlace {
  id: string;
  kind: SavedPlaceKind;
  name: string;
  label: string | null;
  address: string;
  latitude: number;
  longitude: number;
  city: string | null;
  province: string | null;
  country: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriverLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  recordedAt: string;
}
