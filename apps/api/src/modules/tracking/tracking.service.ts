import {
  ACTIVE_TRIP_STATUSES,
  haversineMeters,
  type Freshness,
  type LiveParty,
  type LiveTripSnapshot,
  type TripPlace,
  type TripStatus,
} from '@yatri/types';

import { env } from '../../config/env';
import { getRedisClient } from '../../config/redis';
import { reverseGeocode } from '../location/location.service';
import { getRouteProvider } from '../location/providers';
import { pricingConfig } from '../pricing/pricing.config';
import { settingList } from '../settings/settings.service';
import { publishTripChange } from '../realtime/bus';
import { getLastEventSeq, recordTripEvent } from '../trips/trip-events.service';
import { ODOMETER_MIN_STEP_METERS } from '../trips/ride-actuals';
import { computeWaiting } from '../trips/waiting';
import { computeEta, estimateEta } from './eta';
import { trackingConfig } from './tracking.config';
import {
  evaluateFix,
  freshnessOf,
  shouldRefreshPlaceName,
  type Fix,
  type RejectReason,
  type StoredFix,
} from './tracking.rules';

/**
 * Live positions exist only in Redis, only while a trip is active, and are
 * deleted the moment it ends. There is no location history table: a
 * passenger can never fetch where a driver "was" after the trip.
 *
 * There is ONE driver-location path: the driver's presence connection (availability module)
 * forwards each accepted fix here while the driver has an active trip. Nothing else feeds a
 * driver's position into a trip.
 */
const STATE_TTL_SECONDS = 6 * 60 * 60;
const TERMINAL_META_TTL_SECONDS = 10 * 60;
const ETA_ROUTE_REFRESH_MS = 30_000;
const ETA_ROUTE_REFRESH_MOVE_M = 150;

export type Party = 'driver' | 'passenger';

export interface TripMeta {
  tripId: string;
  status: TripStatus;
  passengerId: string;
  /** Null while SEARCHING (and after a re-match released the previous driver). */
  driverId: string | null;
  pickup: TripPlace;
  destination: TripPlace;
  /** The server-calculated route distance of the whole trip (progress denominator). */
  distanceMeters: number | null;
  matchedAtMs: number | null;
  arrivedAtMs: number | null;
  passengerNotifiedAtMs: number | null;
  /** When the driver was last told the passenger is waiting. */
  driverNotifiedAtMs: number | null;
}

interface PartyState {
  fix: StoredFix;
  /** Smoothed speed (m/s) from consecutive accepted fixes. */
  speedMps: number | null;
  headingDegrees: number | null;
}
interface PlaceState {
  name: string;
  kind: 'road' | 'place' | null;
  latitude: number;
  longitude: number;
  atMs: number;
  stale: boolean;
}
interface EtaState {
  target: 'pickup' | 'destination';
  computedAtMs: number;
  fromLatitude: number;
  fromLongitude: number;
  baseDistanceMeters: number;
  baseEtaSeconds: number | null;
  basis: 'route' | 'estimate';
}

const k = {
  meta: (id: string) => `trk:${id}:meta`,
  party: (id: string, p: Party) => `trk:${id}:${p}`,
  place: (id: string, p: Party) => `trk:${id}:${p}:place`,
  eta: (id: string) => `trk:${id}:eta`,
  version: (id: string) => `trk:${id}:seq`,
  near: (id: string) => `trk:${id}:near`,
  /** Metres driven since the ride started (sum of the driver's accepted location updates). */
  odo: (id: string) => `trk:${id}:odo`,
};

async function getJson<T>(key: string): Promise<T | null> {
  const raw = await getRedisClient().get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}
async function setJson(key: string, value: unknown, ttl = STATE_TTL_SECONDS) {
  await getRedisClient().set(key, JSON.stringify(value), 'EX', ttl);
}

// One writer at a time per trip+party in this process, so read-modify-write of a
// party's state never interleaves with the next update on the same socket.
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    key,
    next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    }),
  );
  return next;
}

export function isActive(status: TripStatus): boolean {
  return ACTIVE_TRIP_STATUSES.includes(status);
}

export async function saveMeta(meta: TripMeta) {
  await setJson(
    k.meta(meta.tripId),
    meta,
    isActive(meta.status) ? STATE_TTL_SECONDS : TERMINAL_META_TTL_SECONDS,
  );
}
export const loadMeta = (tripId: string) => getJson<TripMeta>(k.meta(tripId));

/** Tell every subscribed socket to rebuild its role-specific snapshot. */
export async function bumpTripVersion(tripId: string): Promise<number> {
  const redis = getRedisClient();
  const version = await redis.incr(k.version(tripId));
  await redis.expire(k.version(tripId), STATE_TTL_SECONDS);
  await publishTripChange({ tripId, version });
  return version;
}

export async function clearLiveState(tripId: string) {
  await getRedisClient().del(
    k.party(tripId, 'driver'),
    k.party(tripId, 'passenger'),
    k.place(tripId, 'driver'),
    k.place(tripId, 'passenger'),
    k.eta(tripId),
    k.near(tripId),
    k.odo(tripId),
  );
}

/** Called by the trip lifecycle after every DB status change (the event itself is recorded by the caller). */
export async function onTripStatusChanged(meta: TripMeta): Promise<void> {
  await saveMeta(meta);
  const redis = getRedisClient();
  await redis.del(k.eta(meta.tripId), k.near(meta.tripId)); // target changes (pickup -> destination)
  if (meta.status === 'IN_PROGRESS')
    await redis.set(k.odo(meta.tripId), '0', 'EX', STATE_TTL_SECONDS);
  if (!isActive(meta.status) || meta.status === 'SEARCHING') {
    await clearLiveState(meta.tripId); // privacy: positions die with the trip / a released driver
  }
  await bumpTripVersion(meta.tripId);
}

export type UpdateResult =
  | { accepted: true }
  | { accepted: false; reason: RejectReason | 'not_active' | 'forbidden' | 'not_shared_now' };

export async function applyLocationUpdate(input: {
  tripId: string;
  userId: string;
  party: Party;
  fix: Fix;
  headingDegrees?: number | null;
  nowMs?: number;
}): Promise<UpdateResult> {
  const { tripId, userId, party, fix } = input;
  const nowMs = input.nowMs ?? Date.now();
  const meta = await loadMeta(tripId);
  if (!meta || !isActive(meta.status)) return { accepted: false, reason: 'not_active' };
  // Only the trip's own driver may report the driver position, only its passenger the passenger's.
  if (userId !== (party === 'driver' ? meta.driverId : meta.passengerId)) {
    return { accepted: false, reason: 'forbidden' };
  }
  // Minimum necessary sharing: the driver only needs the passenger's position to find the pickup.
  if (party === 'passenger' && meta.status !== 'DRIVER_EN_ROUTE') {
    return { accepted: false, reason: 'not_shared_now' };
  }

  return serialize(`${tripId}:${party}`, async () => {
    const prevState = await getJson<PartyState>(k.party(tripId, party));
    const before = prevState?.fix ?? null;
    const wasLost = before
      ? freshnessOf(before.receivedAtMs, nowMs, trackingConfig()) === 'lost'
      : false;
    const decision = evaluateFix(before, fix, nowMs, trackingConfig());

    if (!decision.accept) {
      // Persist the pending-jump bookkeeping so a genuinely relocated device is eventually accepted.
      if (decision.next && prevState) {
        await setJson(k.party(tripId, party), { ...prevState, fix: decision.next });
      }
      return { accepted: false as const, reason: decision.reason };
    }

    let speed = prevState?.speedMps ?? null;
    if (before && decision.next.deviceTimeMs > before.deviceTimeMs) {
      const dt = (decision.next.deviceTimeMs - before.deviceTimeMs) / 1000;
      const inst = haversineMeters(before, decision.next) / dt;
      speed = speed === null ? inst : speed * 0.7 + inst * 0.3;
    }
    await setJson(k.party(tripId, party), {
      fix: decision.next,
      speedMps: speed,
      headingDegrees: input.headingDegrees ?? null,
    } satisfies PartyState);

    if (party === 'driver') {
      await refreshEta(meta, decision.next, speed, nowMs);
      // The distance actually driven, for the final fare: only while the ride runs, and only real movement.
      if (meta.status === 'IN_PROGRESS' && before) {
        const step = haversineMeters(before, decision.next);
        if (step >= ODOMETER_MIN_STEP_METERS) {
          await getRedisClient().incrbyfloat(k.odo(tripId), step);
        }
      }
    }
    void refreshPlaceName(tripId, party, decision.next, nowMs); // never blocks the update path

    await bumpTripVersion(tripId);
    if (wasLost && party === 'driver') {
      await recordTripEvent({ tripId, type: 'DRIVER_LOCATION_RESTORED' });
    }
    return { accepted: true as const };
  });
}

/** "Driver is 500 meters away": raised once per configured threshold as the driver closes in. */
async function maybeNearby(meta: TripMeta, distanceMeters: number) {
  if (meta.status !== 'DRIVER_EN_ROUTE') return;
  const thresholds = settingList('NEARBY_NOTIFY_METERS'); // ascending
  const crossed = thresholds.find((t) => distanceMeters <= t);
  if (crossed === undefined) return;
  const redis = getRedisClient();
  const lowest = await redis.get(k.near(meta.tripId));
  if (lowest !== null && Number(lowest) <= crossed) return;
  await redis.set(k.near(meta.tripId), String(crossed), 'EX', STATE_TTL_SECONDS);
  await recordTripEvent({
    tripId: meta.tripId,
    type: 'DRIVER_NEARBY',
    payload: { distanceMeters: Math.round(distanceMeters), thresholdMeters: crossed },
    dedupeKey: `near:${crossed}`,
  });
}

async function refreshEta(meta: TripMeta, fix: StoredFix, speed: number | null, nowMs: number) {
  const target =
    meta.status === 'DRIVER_EN_ROUTE'
      ? ('pickup' as const)
      : meta.status === 'IN_PROGRESS'
        ? ('destination' as const)
        : null;
  if (!target) return;
  const to = target === 'pickup' ? meta.pickup : meta.destination;
  const prev = await getJson<EtaState>(k.eta(meta.tripId));
  const straight = haversineMeters(fix, to);
  await maybeNearby(meta, straight);

  const reusable =
    prev &&
    prev.target === target &&
    prev.basis === 'route' &&
    nowMs - prev.computedAtMs < ETA_ROUTE_REFRESH_MS &&
    haversineMeters({ latitude: prev.fromLatitude, longitude: prev.fromLongitude }, fix) <
      ETA_ROUTE_REFRESH_MOVE_M;
  if (reusable) return; // snapshot scales the stored route ETA by remaining straight-line distance

  const result = await computeEta(fix, to, getRouteProvider(), speed);
  await setJson(k.eta(meta.tripId), {
    target,
    computedAtMs: nowMs,
    fromLatitude: fix.latitude,
    fromLongitude: fix.longitude,
    baseDistanceMeters: Math.max(1, straight),
    baseEtaSeconds: result.etaSeconds,
    basis: result.basis,
  } satisfies EtaState);
}

async function refreshPlaceName(tripId: string, party: Party, fix: StoredFix, nowMs: number) {
  try {
    const last = await getJson<PlaceState>(k.place(tripId, party));
    if (
      !shouldRefreshPlaceName(last ? { ...last } : null, fix, nowMs, {
        minMoveMeters: 75,
        minIntervalMs: env.TRACKING_PLACE_REFRESH_MS,
      })
    )
      return;
    try {
      const r = await reverseGeocode({ latitude: fix.latitude, longitude: fix.longitude });
      const changed = !last || last.name !== r.name;
      await setJson(k.place(tripId, party), {
        name: r.name,
        kind: r.kind ?? null,
        latitude: fix.latitude,
        longitude: fix.longitude,
        atMs: nowMs,
        stale: false,
      } satisfies PlaceState);
      // Only wake subscribers when the name actually changed (or was recovered).
      if (changed || last?.stale) await bumpTripVersion(tripId);
    } catch {
      // Geocoding failed: keep the previous name, flag it as stale, and retry after the normal interval.
      if (last) {
        await setJson(k.place(tripId, party), { ...last, atMs: nowMs, stale: true });
        if (!last.stale) await bumpTripVersion(tripId);
      }
    }
  } catch (err) {
    console.error('place name refresh failed', err);
  }
}

function toParty(
  state: PartyState | null,
  place: PlaceState | null,
  nowMs: number,
): LiveParty | null {
  if (!state) return null;
  const age = Math.max(0, nowMs - state.fix.receivedAtMs);
  const freshness: Freshness = freshnessOf(state.fix.receivedAtMs, nowMs, trackingConfig());
  return {
    latitude: state.fix.latitude,
    longitude: state.fix.longitude,
    accuracyMeters: state.fix.accuracyMeters,
    headingDegrees: state.headingDegrees ?? null,
    updatedAt: new Date(state.fix.receivedAtMs).toISOString(),
    ageSeconds: Math.round(age / 1000),
    freshness,
    placeName: place?.name ?? null,
    placeKind: place?.kind ?? null,
    placeStale: place ? place.stale : state.fix ? true : false,
  };
}

/**
 * The privacy boundary: what each side of a trip may see is decided here and
 * nowhere else. Terminal trips reveal no positions at all.
 */
export async function buildSnapshot(
  meta: TripMeta,
  viewer: 'PASSENGER' | 'DRIVER',
  nowMs = Date.now(),
): Promise<LiveTripSnapshot> {
  const active = isActive(meta.status);
  const redis = getRedisClient();
  const version = Number((await redis.get(k.version(meta.tripId))) ?? 0);

  const [driverState, driverPlace, passengerState, passengerPlace, eta] = active
    ? await Promise.all([
        getJson<PartyState>(k.party(meta.tripId, 'driver')),
        getJson<PlaceState>(k.place(meta.tripId, 'driver')),
        getJson<PartyState>(k.party(meta.tripId, 'passenger')),
        getJson<PlaceState>(k.place(meta.tripId, 'passenger')),
        getJson<EtaState>(k.eta(meta.tripId)),
      ])
    : [null, null, null, null, null];

  const driver = toParty(driverState, driverPlace, nowMs);
  // A driver only sees the passenger while heading to pickup, and only if the passenger chose to share.
  const passengerVisible = viewer === 'PASSENGER' || meta.status === 'DRIVER_EN_ROUTE';
  const passenger = passengerVisible ? toParty(passengerState, passengerPlace, nowMs) : null;

  let driverArrival: LiveTripSnapshot['driverArrival'] = null;
  let trip: LiveTripSnapshot['trip'] = null;
  if (driverState && (meta.status === 'DRIVER_EN_ROUTE' || meta.status === 'IN_PROGRESS')) {
    const target = meta.status === 'DRIVER_EN_ROUTE' ? meta.pickup : meta.destination;
    const distance = Math.round(haversineMeters(driverState.fix, target));
    const etaSeconds = etaFor(eta, meta.status, distance, driverState.speedMps);
    const basis = eta?.basis ?? 'estimate';
    if (meta.status === 'DRIVER_EN_ROUTE') {
      driverArrival = { distanceMeters: distance, etaSeconds, basis };
    } else {
      const total = meta.distanceMeters;
      trip = {
        distanceRemainingMeters: distance,
        etaSeconds,
        progressPercent:
          total && total > 0
            ? Math.max(0, Math.min(100, Math.round((1 - distance / total) * 100)))
            : null,
        basis,
      };
    }
  }

  return {
    tripId: meta.tripId,
    status: meta.status,
    version,
    lastEventSeq: await getLastEventSeq(meta.tripId),
    serverTime: new Date(nowMs).toISOString(),
    pickup: meta.pickup,
    destination: meta.destination,
    driver,
    passenger,
    driverArrival,
    trip,
    // Waiting is computed from server timestamps only; both apps render exactly this.
    waiting: computeWaiting(meta, nowMs, pricingConfig()),
  };
}

function etaFor(
  eta: EtaState | null,
  status: TripStatus,
  distanceNow: number,
  speed: number | null,
): number | null {
  const wantTarget = status === 'DRIVER_EN_ROUTE' ? 'pickup' : 'destination';
  if (eta && eta.target === wantTarget && eta.baseEtaSeconds !== null) {
    // Scale the stored ETA by how much straight-line distance is left.
    const ratio = Math.min(1.5, distanceNow / eta.baseDistanceMeters);
    return Math.max(0, Math.round(eta.baseEtaSeconds * ratio));
  }
  return estimateEta(distanceNow, speed).etaSeconds;
}

/** Freshness of the driver's feed right now — used by the staleness sweeper. */
export async function driverFreshness(tripId: string, nowMs = Date.now()): Promise<Freshness> {
  const state = await getJson<PartyState>(k.party(tripId, 'driver'));
  return freshnessOf(state?.fix.receivedAtMs ?? null, nowMs, trackingConfig());
}

export async function passengerStopsSharing(tripId: string): Promise<void> {
  await getRedisClient().del(k.party(tripId, 'passenger'), k.place(tripId, 'passenger'));
  await bumpTripVersion(tripId);
}

export async function announceStaleness(tripId: string, freshness: Freshness) {
  if (freshness === 'lost') await recordTripEvent({ tripId, type: 'DRIVER_LOCATION_LOST' });
  await bumpTripVersion(tripId);
}

/** The driver's latest accepted position for a trip (server-side use only; never sent as history). */
/** Metres the driver has covered since the ride started (0 when nothing was measured). */
export async function readOdometerMeters(tripId: string): Promise<number> {
  const raw = await getRedisClient().get(k.odo(tripId));
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function getDriverFix(
  tripId: string,
): Promise<{ latitude: number; longitude: number; receivedAtMs: number } | null> {
  const s = await getJson<PartyState>(k.party(tripId, 'driver'));
  return s
    ? { latitude: s.fix.latitude, longitude: s.fix.longitude, receivedAtMs: s.fix.receivedAtMs }
    : null;
}
