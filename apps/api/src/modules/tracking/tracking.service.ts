import type {
  Freshness,
  LiveParty,
  LiveTripSnapshot,
  TripEventName,
  TripPlace,
  TripStatus,
} from '@yatri/types';
import { ACTIVE_TRIP_STATUSES } from '@yatri/types';

import { env } from '../../config/env';
import { getRedisClient } from '../../config/redis';
import { haversineMeters } from '../location/geo';
import { reverseGeocode } from '../location/location.service';
import { getRouteProvider } from '../location/providers';
import { publishTripChange } from '../realtime/bus';
import { computeEta, estimateEta } from './eta';
import {
  DEFAULT_TRACKING_CONFIG,
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
 */
const STATE_TTL_SECONDS = 6 * 60 * 60;
const TERMINAL_META_TTL_SECONDS = 10 * 60;
const ETA_ROUTE_REFRESH_MS = 30_000;
const ETA_ROUTE_REFRESH_MOVE_M = 150;

const trackingConfig = () => ({
  ...DEFAULT_TRACKING_CONFIG,
  minIntervalMs: env.TRACKING_MIN_INTERVAL_MS,
});

export type Party = 'driver' | 'passenger';

export interface TripMeta {
  tripId: string;
  status: TripStatus;
  passengerId: string;
  driverId: string;
  pickup: TripPlace;
  destination: TripPlace;
  arrivedAtMs: number | null;
}

interface PartyState {
  fix: StoredFix;
  /** Smoothed speed (m/s) from consecutive accepted fixes. */
  speedMps: number | null;
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
  seq: (id: string) => `trk:${id}:seq`,
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

async function nextEventId(tripId: string): Promise<number> {
  return getRedisClient().incr(k.seq(tripId));
}

async function announce(tripId: string, event?: TripEventName, important = false) {
  const eventId = await nextEventId(tripId);
  await getRedisClient().expire(k.seq(tripId), STATE_TTL_SECONDS);
  await publishTripChange({ tripId, eventId, event, important });
  return eventId;
}

export async function clearLiveState(tripId: string) {
  await getRedisClient().del(
    k.party(tripId, 'driver'),
    k.party(tripId, 'passenger'),
    k.place(tripId, 'driver'),
    k.place(tripId, 'passenger'),
    k.eta(tripId),
  );
}

/** Called by the trip lifecycle after every DB status change. */
export async function onTripStatusChanged(meta: TripMeta, event: TripEventName): Promise<void> {
  await saveMeta(meta);
  await getRedisClient().del(k.eta(meta.tripId)); // target changes (pickup -> destination)
  if (!isActive(meta.status)) {
    await clearLiveState(meta.tripId); // privacy: positions die with the trip
  }
  await announce(meta.tripId, event, true);
}

export type UpdateResult =
  | { accepted: true }
  | { accepted: false; reason: RejectReason | 'not_active' | 'forbidden' | 'not_shared_now' };

export async function applyLocationUpdate(input: {
  tripId: string;
  userId: string;
  party: Party;
  fix: Fix;
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
    const wasLost = before ? freshnessOf(before.receivedAtMs, nowMs) === 'lost' : false;
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
    } satisfies PartyState);

    if (party === 'driver') {
      await refreshEta(meta, decision.next, speed, nowMs);
    }
    void refreshPlaceName(tripId, party, decision.next, nowMs); // never blocks the update path

    await announce(tripId, wasLost && party === 'driver' ? 'DRIVER_LOCATION_RESTORED' : undefined);
    return { accepted: true as const };
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
      if (changed || last?.stale) await announce(tripId);
    } catch {
      // Geocoding failed: keep the previous name, flag it as stale, and retry after the normal interval.
      if (last) {
        await setJson(k.place(tripId, party), { ...last, atMs: nowMs, stale: true });
        if (!last.stale) await announce(tripId);
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
  const freshness: Freshness = freshnessOf(state.fix.receivedAtMs, nowMs);
  return {
    latitude: state.fix.latitude,
    longitude: state.fix.longitude,
    accuracyMeters: state.fix.accuracyMeters,
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
  const eventId = Number((await redis.get(k.seq(meta.tripId))) ?? 0);

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
      trip = { distanceRemainingMeters: distance, etaSeconds, basis };
    }
  }

  return {
    tripId: meta.tripId,
    status: meta.status,
    eventId,
    serverTime: new Date(nowMs).toISOString(),
    pickup: meta.pickup,
    destination: meta.destination,
    driver,
    passenger,
    driverArrival,
    trip,
    waitingSeconds:
      meta.status === 'DRIVER_ARRIVED' && meta.arrivedAtMs
        ? Math.max(0, Math.round((nowMs - meta.arrivedAtMs) / 1000))
        : null,
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
  return freshnessOf(state?.fix.receivedAtMs ?? null, nowMs, DEFAULT_TRACKING_CONFIG);
}

export async function passengerStopsSharing(tripId: string): Promise<void> {
  await getRedisClient().del(k.party(tripId, 'passenger'), k.place(tripId, 'passenger'));
  await announce(tripId);
}

export async function announceStaleness(tripId: string, freshness: Freshness) {
  if (freshness === 'lost') await announce(tripId, 'DRIVER_LOCATION_LOST', true);
  else await announce(tripId);
}
