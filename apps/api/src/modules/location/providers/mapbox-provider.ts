import type { PlaceSummary, ReverseGeocodeResult } from '@yatri/types';

import { roundCoordinate, type Coordinate } from '../coordinates';
import { fetchJson } from './http';
import {
  LocationProviderError,
  type LocationProvider,
  type SearchOptions,
} from './location-provider';

export interface MapboxGeocodingConfig {
  baseUrl: string;
  accessToken: string;
  countryCodes: string[];
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface MapboxFeature {
  text?: string;
  place_name?: string;
  center?: [number, number];
  place_type?: string[];
  context?: Array<{ id?: string; text?: string; short_code?: string }>;
}

const contextOf = (f: MapboxFeature, prefix: string) =>
  f.context?.find((c) => c.id?.startsWith(`${prefix}.`))?.text?.trim() || null;

/** Mapbox Geocoding, normalised to the same PlaceSummary every other geocoder returns. */
export class MapboxGeocodingProvider implements LocationProvider {
  readonly name = 'mapbox';
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly c: MapboxGeocodingConfig) {
    this.fetchImpl = c.fetchImpl ?? fetch;
  }

  async search(query: string, options: SearchOptions): Promise<PlaceSummary[]> {
    const params = this.params();
    params.set('limit', String(Math.min(options.limit, 10)));
    if (options.near) params.set('proximity', `${options.near.longitude},${options.near.latitude}`);
    const body = await this.get(`/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`, params);
    const seen = new Set<string>();
    const out: PlaceSummary[] = [];
    for (const f of body.features) {
      const place = this.toPlace(f);
      if (!place) continue;
      const key = `${place.name.toLowerCase()}|${place.latitude.toFixed(3)}|${place.longitude.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(place);
      if (out.length >= options.limit) break;
    }
    return out;
  }

  async geocode(query: string): Promise<PlaceSummary | null> {
    return (await this.search(query, { limit: 1 }))[0] ?? null;
  }

  async reverseGeocode(point: Coordinate): Promise<ReverseGeocodeResult | null> {
    const params = this.params();
    params.set('limit', '1');
    const body = await this.get(`/geocoding/v5/mapbox.places/${point.longitude},${point.latitude}.json`, params);
    const f = body.features[0];
    const place = f ? this.toPlace(f, point) : null;
    if (!place || !f) return null; // nothing known there: a valid answer, not a failure
    return { ...place, formattedAddress: f.place_name ?? [place.name, place.city, place.country].filter(Boolean).join(', ') };
  }

  private params(): URLSearchParams {
    const p = new URLSearchParams({ access_token: this.c.accessToken, language: 'en,ne' });
    if (this.c.countryCodes.length) p.set('country', this.c.countryCodes.join(','));
    return p;
  }

  private async get(path: string, params: URLSearchParams): Promise<{ features: MapboxFeature[] }> {
    const body = await fetchJson<{ features?: MapboxFeature[] }>(
      this.fetchImpl,
      `${this.c.baseUrl.replace(/\/$/, '')}${path}?${params}`,
      { headers: { Accept: 'application/json' } },
      this.c.timeoutMs,
      'mapbox',
    );
    if (!body || !Array.isArray(body.features)) throw new LocationProviderError('BAD_RESPONSE', 'mapbox: no features');
    return { features: body.features };
  }

  private toPlace(f: MapboxFeature, fallback?: Coordinate): PlaceSummary | null {
    const [lng, lat] = f.center ?? [fallback?.longitude, fallback?.latitude];
    if (
      typeof lat !== 'number' || typeof lng !== 'number' ||
      !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180
    ) return null;
    const city = contextOf(f, 'place') ?? contextOf(f, 'locality') ?? contextOf(f, 'district');
    const province = contextOf(f, 'region');
    const country = contextOf(f, 'country');
    const name = f.text?.trim() || city;
    if (!name) return null;
    const local = contextOf(f, 'neighborhood');
    const secondary = [local, city, province].filter((p, i, a): p is string => !!p && p !== name && a.indexOf(p) === i);
    return {
      name,
      address: secondary.join(', ') || country || '',
      latitude: roundCoordinate(lat),
      longitude: roundCoordinate(lng),
      city,
      province,
      country,
      postalCode: contextOf(f, 'postcode'),
      kind: f.place_type?.includes('address') ? 'road' : 'place',
    };
  }
}
