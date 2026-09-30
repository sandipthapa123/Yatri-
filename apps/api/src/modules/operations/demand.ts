import { pointInPolygon, type ZoneDemandSupply } from '@yatri/types';

import { query } from '../../lib/db';
import { availableDriverPositions } from '../dispatch/matching';
import { settingNumber } from '../settings/settings.service';
import { activeZones } from './zones.service';

/**
 * The demand and supply picture: ride requests in the recent window against drivers who could take a ride
 * right now, for the whole service and for each zone. ONE definition, used by dynamic pricing (a rule that
 * depends on demand) and by the operations screens, so the number a rule reacts to is the number an admin
 * sees. Supply is `availableDriverPositions` (the matching module's own conditions), never a second query.
 *
 * Only counts leave this module: no driver id and no rider is returned.
 */
export interface RawDemand {
  requests: Array<{ latitude: number; longitude: number }>;
  drivers: Array<{ latitude: number; longitude: number }>;
  windowMinutes: number;
}

const CACHE_MS = 10_000;
let cache: { at: number; value: RawDemand } | null = null;
export const dropDemandCache = () => {
  cache = null;
};

export async function rawDemand(): Promise<RawDemand> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const windowMinutes = settingNumber('SURGE_DEMAND_WINDOW_MINUTES');
  const [req, drivers] = await Promise.all([
    query<{ latitude: number; longitude: number }>(
      `SELECT pl.latitude::float8 AS latitude, pl.longitude::float8 AS longitude
       FROM trips t JOIN locations pl ON pl.id = t.pickup_location_id
       WHERE t.requested_at > now() - ($1::int * interval '1 minute')`,
      [windowMinutes],
    ),
    availableDriverPositions(),
  ]);
  const value: RawDemand = { requests: req.rows, drivers, windowMinutes };
  cache = { at: Date.now(), value };
  return value;
}

/** Requests per available driver (all requests when nobody is available). */
export const demandRatio = (requests: number, drivers: number) =>
  drivers === 0 ? requests : Math.round((requests / drivers) * 100) / 100;

/** Demand against supply for one zone, or for the whole service when `zoneId` is null. */
export async function ratioFor(zoneId: string | null): Promise<number> {
  const d = await rawDemand();
  if (zoneId === null) return demandRatio(d.requests.length, d.drivers.length);
  const zone = (await activeZones()).find((z) => z.id === zoneId);
  if (!zone) return 0;
  const inside = (p: { latitude: number; longitude: number }) => pointInPolygon(p, zone.polygon);
  return demandRatio(d.requests.filter(inside).length, d.drivers.filter(inside).length);
}

/** The service as a whole, then every active zone: the table the operations screen prints. */
export async function demandSupplyTable(): Promise<Omit<ZoneDemandSupply, 'surgeMultiplier'>[]> {
  const d = await rawDemand();
  const zones = await activeZones();
  const all = {
    zoneId: null,
    zoneName: 'The whole service',
    kind: null,
    requests: d.requests.length,
    availableDrivers: d.drivers.length,
    ratio: demandRatio(d.requests.length, d.drivers.length),
  };
  const perZone = zones.map((z) => {
    const inside = (p: { latitude: number; longitude: number }) => pointInPolygon(p, z.polygon);
    const requests = d.requests.filter(inside).length;
    const availableDrivers = d.drivers.filter(inside).length;
    return {
      zoneId: z.id,
      zoneName: z.name,
      kind: z.kind,
      requests,
      availableDrivers,
      ratio: demandRatio(requests, availableDrivers),
    };
  });
  return [all, ...perZone];
}
