import type { PlaceSummary, ReverseGeocodeResult } from '@yatri/types';

import { roundCoordinate, type Coordinate } from '../coordinates';
import { fetchJson } from './http';
import {
  LocationProviderError,
  type LocationProvider,
  type SearchOptions,
} from './location-provider';

export interface NominatimConfig {
  baseUrl: string;
  apiKey?: string;
  userAgent: string;
  countryCodes: string[];
  timeoutMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

type NominatimAddress = Record<string, string | undefined>;
interface NominatimItem {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  category?: string;
  addresstype?: string;
  address?: NominatimAddress;
}

const CITY_KEYS = ['city', 'town', 'municipality', 'village', 'city_district', 'county'] as const;
const LOCAL_KEYS = ['neighbourhood', 'suburb', 'quarter', 'hamlet', 'road'] as const;

function firstOf(address: NominatimAddress, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = address[k]?.trim();
    if (v) return v;
  }
  return null;
}

/**
 * Nominatim-compatible geocoder (OpenStreetMap Nominatim, self-hosted, or
 * LocationIQ-style services). Nepal has no street-number addressing, so
 * labels are built from named components (locality, city, province) rather
 * than "123 Main St".
 */
export class NominatimProvider implements LocationProvider {
  readonly name = 'nominatim';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: NominatimConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async search(query: string, options: SearchOptions): Promise<PlaceSummary[]> {
    const params = this.baseParams();
    params.set('q', query);
    params.set('limit', String(Math.min(options.limit * 2, 20))); // over-fetch, then dedupe
    if (this.config.countryCodes.length) {
      params.set('countrycodes', this.config.countryCodes.join(','));
    }
    if (options.near) {
      // ~55 km soft bias window; "bounded" stays off so distant matches still appear.
      const d = 0.5;
      const { latitude: lat, longitude: lon } = options.near;
      params.set('viewbox', [lon - d, lat + d, lon + d, lat - d].join(','));
    }
    const items = await this.get<NominatimItem[]>('/search', params);
    if (!Array.isArray(items)) {
      throw new LocationProviderError('BAD_RESPONSE', 'search: not an array');
    }

    const seen = new Set<string>();
    const out: PlaceSummary[] = [];
    for (const item of items) {
      const place = this.toPlace(item);
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
    const [first] = await this.search(query, { limit: 1 });
    return first ?? null;
  }

  async reverseGeocode(point: Coordinate): Promise<ReverseGeocodeResult | null> {
    const params = this.baseParams();
    params.set('lat', String(point.latitude));
    params.set('lon', String(point.longitude));
    params.set('zoom', '18');
    const item = await this.get<NominatimItem & { error?: string }>('/reverse', params);
    if (!item || typeof item !== 'object') {
      throw new LocationProviderError('BAD_RESPONSE', 'reverse: bad body');
    }
    if (item.error) return null; // "Unable to geocode": a valid answer, not a failure

    const place = this.toPlace(item, point);
    if (!place) return null;
    const formattedAddress = [place.name, place.city, place.province, place.country]
      .filter((p, i, arr): p is string => !!p && arr.indexOf(p) === i)
      .join(', ');
    return { ...place, formattedAddress };
  }

  private baseParams(): URLSearchParams {
    const params = new URLSearchParams({
      format: 'jsonv2',
      addressdetails: '1',
      'accept-language': 'en,ne',
    });
    if (this.config.apiKey) params.set('key', this.config.apiKey);
    return params;
  }

  private toPlace(item: NominatimItem, fallback?: Coordinate): PlaceSummary | null {
    const latitude = item.lat !== undefined ? Number(item.lat) : fallback?.latitude;
    const longitude = item.lon !== undefined ? Number(item.lon) : fallback?.longitude;
    if (
      latitude === undefined ||
      longitude === undefined ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      return null;
    }
    const address = item.address ?? {};
    const city = firstOf(address, CITY_KEYS);
    const province = address.state?.trim() || null;
    const country = address.country?.trim() || null;
    const postalCode = address.postcode?.trim() || null;
    const name =
      item.name?.trim() ||
      firstOf(address, LOCAL_KEYS) ||
      item.display_name?.split(',')[0]?.trim() ||
      city;
    if (!name) return null;

    // Secondary line: enough context to tell "Thamel" from "Thamel Chowk" apart.
    const secondary = [firstOf(address, LOCAL_KEYS), city, province].filter(
      (p, i, arr): p is string => !!p && p !== name && arr.indexOf(p) === i,
    );
    return {
      name,
      address: secondary.join(', ') || country || '',
      latitude: roundCoordinate(latitude),
      longitude: roundCoordinate(longitude),
      city,
      province,
      country,
      postalCode,
      kind: item.category === 'highway' || item.addresstype === 'road' ? 'road' : 'place',
    };
  }

  private get<T>(path: string, params: URLSearchParams): Promise<T> {
    return fetchJson<T>(
      this.fetchImpl,
      `${this.config.baseUrl.replace(/\/$/, '')}${path}?${params}`,
      { headers: { 'User-Agent': this.config.userAgent, Accept: 'application/json' } },
      this.config.timeoutMs,
      'nominatim',
    );
  }
}
