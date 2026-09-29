import type { LiveTripSnapshot, TripStatus } from '@yatri/types';

import { distancePhrase, etaPhrase, liveSentence, placePhrase, type Viewer } from './tripText';

/**
 * Decides WHEN the live trip region speaks. Screen-reader users must be
 * kept informed without being flooded by GPS jitter, so:
 *  - distance only re-announces after a meaningful change (50 m when close,
 *    100 m mid-range, 500 m far), never for a few metres of drift;
 *  - ETA only after a change of a minute or 40%;
 *  - place names only when the name actually changes;
 *  - ordinary updates are POLITE and rate limited; only genuinely
 *    important changes (arrived, started, completed, cancelled, GPS lost)
 *    are ASSERTIVE and bypass the rate limit.
 * Speech is driven by snapshot changes only. Realtime "event" messages are
 * deliberately NOT spoken separately, or every arrival would be read twice.
 */
export interface AnnounceState {
  lastPoliteAtMs: number | null;
  announcedDistance: number | null;
  announcedEtaSeconds: number | null;
  announcedPlace: string | null;
  announcedPlaceStale: boolean;
  status: TripStatus | null;
  freshness: string | null;
  announcedVeryClose: boolean;
}

export const INITIAL_ANNOUNCE_STATE: AnnounceState = {
  lastPoliteAtMs: null,
  announcedDistance: null,
  announcedEtaSeconds: null,
  announcedPlace: null,
  announcedPlaceStale: false,
  status: null,
  freshness: null,
  announcedVeryClose: false,
};

export interface Announcement {
  polite?: string;
  assertive?: string;
}

export const POLITE_MIN_INTERVAL_MS = 10_000;

export function distanceStep(meters: number): number {
  if (meters < 300) return 50;
  if (meters < 1000) return 100;
  return 500;
}

const IMPORTANT_STATUS_TEXT: Partial<Record<TripStatus, (v: Viewer) => string>> = {
  DRIVER_ARRIVED: (v) =>
    v === 'PASSENGER'
      ? 'Your driver has arrived at the pickup.'
      : 'You have arrived at the pickup.',
  IN_PROGRESS: () => 'Your trip has started.',
  COMPLETED: () => 'Trip completed. You have reached your destination.',
  CANCELLED: () => 'This trip was cancelled.',
};

export function decideAnnouncement(
  prev: AnnounceState,
  s: LiveTripSnapshot,
  nowMs: number,
  viewer: Viewer,
): { announcement: Announcement; next: AnnounceState } {
  const next: AnnounceState = { ...prev, status: s.status };
  const out: Announcement = {};

  // ---- important (assertive) ----
  if (prev.status !== null && prev.status !== s.status) {
    const text = IMPORTANT_STATUS_TEXT[s.status]?.(viewer);
    if (text) out.assertive = text;
    // A new phase re-baselines distance/ETA (arrival ETA -> trip ETA are different things).
    next.announcedDistance = null;
    next.announcedEtaSeconds = null;
    next.announcedVeryClose = false;
  }

  const freshness = s.driver?.freshness ?? null;
  if (freshness !== prev.freshness) {
    next.freshness = freshness;
    if (freshness === 'lost' && prev.freshness !== null) {
      out.assertive = [
        out.assertive,
        viewer === 'PASSENGER'
          ? 'Driver location signal lost. Showing the last known position.'
          : 'Your location signal is lost. Move to an open area.',
      ]
        .filter(Boolean)
        .join(' ');
    }
  }

  if (s.status === 'COMPLETED' || s.status === 'CANCELLED') {
    return { announcement: out, next };
  }

  // ---- ordinary (polite, rate limited) ----
  const politeParts: string[] = [];
  const distance = s.driverArrival?.distanceMeters ?? s.trip?.distanceRemainingMeters ?? null;
  const eta = s.driverArrival?.etaSeconds ?? s.trip?.etaSeconds ?? null;

  const first =
    prev.announcedDistance === null && prev.announcedPlace === null && prev.lastPoliteAtMs === null;
  const distanceChanged =
    distance !== null &&
    (prev.announcedDistance === null ||
      Math.abs(distance - prev.announcedDistance) >= distanceStep(prev.announcedDistance));
  const veryClose =
    distance !== null &&
    distance <= 30 &&
    !prev.announcedVeryClose &&
    s.status === 'DRIVER_EN_ROUTE';
  const etaChanged =
    eta !== null &&
    prev.announcedEtaSeconds !== null &&
    Math.abs(eta - prev.announcedEtaSeconds) >= Math.max(60, prev.announcedEtaSeconds * 0.4);
  const placeName = s.driver?.placeName ?? null;
  const placeChanged = placeName !== null && placeName !== prev.announcedPlace;
  const placeBecameStale =
    !!s.driver && s.driver.placeStale && !prev.announcedPlaceStale && prev.announcedPlace !== null;
  const recovered = freshness === 'live' && prev.freshness !== null && prev.freshness !== 'live';

  const rateOk =
    prev.lastPoliteAtMs === null || nowMs - prev.lastPoliteAtMs >= POLITE_MIN_INTERVAL_MS;

  if (!out.assertive && rateOk && s.driver) {
    if (first) {
      politeParts.push(liveSentence(s, viewer));
    } else {
      if (veryClose || distanceChanged) {
        if (s.driverArrival) {
          politeParts.push(
            viewer === 'PASSENGER'
              ? distancePhrase('Driver', s.driverArrival.distanceMeters)
              : distancePhrase('Pickup', s.driverArrival.distanceMeters),
          );
          const e = etaPhrase('arrival', s.driverArrival.etaSeconds);
          if (e) politeParts.push(e);
        } else if (s.trip) {
          politeParts.push(`${distancePhrase('Destination', s.trip.distanceRemainingMeters)}`);
          const e = etaPhrase('trip', s.trip.etaSeconds);
          if (e) politeParts.push(e);
        }
      } else if (etaChanged) {
        const e = s.driverArrival ? etaPhrase('arrival', eta) : etaPhrase('trip', eta);
        if (e) politeParts.push(e);
      }
      if (placeChanged) {
        const p = placePhrase(
          viewer === 'PASSENGER' ? 'Driver' : 'You',
          placeName,
          s.driver.placeKind,
          viewer === 'PASSENGER' ? 'is' : 'are',
        );
        if (p) politeParts.push(p);
      } else if (placeBecameStale) {
        politeParts.push('Place name temporarily unavailable.');
      }
      if (recovered)
        politeParts.unshift(
          viewer === 'PASSENGER' ? 'Driver location is back.' : 'Location signal restored.',
        );
    }
  }

  if (politeParts.length > 0) {
    out.polite = politeParts.join(' ');
    next.lastPoliteAtMs = nowMs;
    if (distance !== null) next.announcedDistance = distance;
    if (eta !== null) next.announcedEtaSeconds = eta;
    if (placeName !== null) next.announcedPlace = placeName;
    next.announcedPlaceStale = !!s.driver?.placeStale;
    if (distance !== null && distance <= 30) next.announcedVeryClose = true;
  }

  return { announcement: out, next };
}
