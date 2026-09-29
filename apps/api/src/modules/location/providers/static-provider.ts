import type { PlaceSummary, ReverseGeocodeResult } from '@yatri/types';

import type { Coordinate } from '../coordinates';
import { haversineMeters } from '../geo';
import type { LocationProvider, SearchOptions } from './location-provider';

export interface GazetteerEntry extends PlaceSummary {
  /** Alternate spellings / Nepali script the entry should also match. */
  aliases?: string[];
}

const NEPAL = { province: null, country: 'Nepal', postalCode: null } as const;

/** A small offline gazetteer of well-known Nepali places. Deliberately tiny: it is a dev/test fallback, not a product. */
export const DEFAULT_GAZETTEER: GazetteerEntry[] = [
  {
    name: 'Thamel',
    address: 'Kathmandu, Bagmati Province',
    latitude: 27.7154,
    longitude: 85.3123,
    city: 'Kathmandu',
    ...NEPAL,
    province: 'Bagmati Province',
    kind: 'place',
    aliases: ['थमेल'],
  },
  {
    name: 'New Road',
    address: 'Kathmandu, Bagmati Province',
    latitude: 27.7041,
    longitude: 85.3131,
    city: 'Kathmandu',
    ...NEPAL,
    province: 'Bagmati Province',
    kind: 'road',
    aliases: ['न्यू रोड', 'newroad'],
  },
  {
    name: 'Kathmandu Durbar Square',
    address: 'Kathmandu, Bagmati Province',
    latitude: 27.7048,
    longitude: 85.3076,
    city: 'Kathmandu',
    ...NEPAL,
    province: 'Bagmati Province',
    kind: 'place',
    aliases: ['basantapur', 'हनुमानढोका'],
  },
  {
    name: 'Patan Durbar Square',
    address: 'Lalitpur, Bagmati Province',
    latitude: 27.6727,
    longitude: 85.325,
    city: 'Lalitpur',
    ...NEPAL,
    province: 'Bagmati Province',
    kind: 'place',
    aliases: ['पाटन दरबार क्षेत्र'],
  },
  {
    name: 'Bhaktapur Durbar Square',
    address: 'Bhaktapur, Bagmati Province',
    latitude: 27.6722,
    longitude: 85.4298,
    city: 'Bhaktapur',
    ...NEPAL,
    province: 'Bagmati Province',
    kind: 'place',
    aliases: ['भक्तपुर दरबार क्षेत्र'],
  },
  {
    name: 'Lakeside',
    address: 'Pokhara, Gandaki Province',
    latitude: 28.2096,
    longitude: 83.9592,
    city: 'Pokhara',
    ...NEPAL,
    province: 'Gandaki Province',
    kind: 'place',
    aliases: ['लेकसाइड'],
  },
  {
    name: 'Pokhara',
    address: 'Gandaki Province',
    latitude: 28.2096,
    longitude: 83.9856,
    city: 'Pokhara',
    ...NEPAL,
    province: 'Gandaki Province',
    kind: 'place',
    aliases: ['पोखरा'],
  },
  {
    name: 'Biratnagar',
    address: 'Koshi Province',
    latitude: 26.4525,
    longitude: 87.2718,
    city: 'Biratnagar',
    ...NEPAL,
    province: 'Koshi Province',
    kind: 'place',
    aliases: ['विराटनगर'],
  },
  {
    name: 'Bharatpur',
    address: 'Chitwan, Bagmati Province',
    latitude: 27.6833,
    longitude: 84.4333,
    city: 'Bharatpur',
    ...NEPAL,
    province: 'Bagmati Province',
    kind: 'place',
    aliases: ['भरतपुर'],
  },
  {
    name: 'Nepalgunj',
    address: 'Lumbini Province',
    latitude: 28.05,
    longitude: 81.6167,
    city: 'Nepalgunj',
    ...NEPAL,
    province: 'Lumbini Province',
    kind: 'place',
    aliases: ['नेपालगञ्ज'],
  },
];

const norm = (s: string) => s.normalize('NFC').toLowerCase();

/**
 * Offline LocationProvider backed by an in-memory gazetteer. Exists so the
 * app (and its tests) run with no network and no key, and to prove the
 * abstraction: selecting it changes nothing outside providers/.
 */
export class StaticLocationProvider implements LocationProvider {
  readonly name = 'static';
  constructor(
    private readonly entries: GazetteerEntry[] = DEFAULT_GAZETTEER,
    private readonly maxReverseMeters = 1500,
  ) {}

  private strip(e: GazetteerEntry): PlaceSummary {
    const { aliases: _aliases, ...place } = e;
    void _aliases;
    return place;
  }

  async search(query: string, options: SearchOptions): Promise<PlaceSummary[]> {
    const q = norm(query);
    return this.entries
      .filter((e) => [e.name, ...(e.aliases ?? [])].some((n) => norm(n).includes(q)))
      .sort((a, b) => {
        const rank = (e: GazetteerEntry) => (norm(e.name).startsWith(q) ? 0 : 1);
        return rank(a) - rank(b);
      })
      .slice(0, options.limit)
      .map((e) => this.strip(e));
  }

  async geocode(query: string): Promise<PlaceSummary | null> {
    return (await this.search(query, { limit: 1 }))[0] ?? null;
  }

  async reverseGeocode(point: Coordinate): Promise<ReverseGeocodeResult | null> {
    let best: { e: GazetteerEntry; d: number } | null = null;
    for (const e of this.entries) {
      const d = haversineMeters(point, e);
      if (!best || d < best.d) best = { e, d };
    }
    if (!best || best.d > this.maxReverseMeters) return null;
    const p = this.strip(best.e);
    return {
      ...p,
      formattedAddress: [p.name, p.city, p.province, p.country]
        .filter((x, i, a): x is string => !!x && a.indexOf(x) === i)
        .join(', '),
    };
  }
}
