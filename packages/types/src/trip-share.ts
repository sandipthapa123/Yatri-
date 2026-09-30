import { formatDistance, formatDuration, formatElapsed } from './format';
import type { Freshness, TripStatus } from './trip';

/**
 * Sharing a live trip with a trusted contact: the definitions, once. The passenger creates a link
 * (the token is shown only at that moment); whoever holds it sees ONLY this view — never a phone
 * number, never the passenger's identity, never anything about other rides.
 */

/** Links are 32 random bytes, base64url: 43 characters. Anything else is rejected before a lookup. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ShareCreated {
  shareId: string;
  /** The link to send. The token inside it cannot be retrieved again. */
  url: string;
  expiresAt: string;
}

export interface ShareInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** False once it has been stopped, the ride has ended, or the sharing period is over. */
  active: boolean;
}

/** What the person holding a share link is allowed to see. Derived from the same live snapshot the passenger sees. */
export interface ShareView {
  status: TripStatus;
  /** The ride is over: the link then shows the outcome and no location. */
  ended: boolean;
  driver: {
    /** First name only. */
    firstName: string | null;
    vehicle: string | null;
    registration: string | null;
  } | null;
  /** Only while a driver is assigned and the ride is live. */
  location: {
    latitude: number;
    longitude: number;
    placeName: string | null;
    freshness: Freshness;
  } | null;
  pickup: { name: string };
  destination: { name: string; address: string };
  /** Metres to the pickup while the driver approaches, to the destination while riding. */
  distanceMeters: number | null;
  distanceTo: 'pickup' | 'destination' | null;
  etaSeconds: number | null;
  /** How long the driver has waited at the pickup (server clock). */
  waitingSeconds: number | null;
  expiresAt: string;
  updatedAt: string;
}

/**
 * The words for a shared trip: one headline (announced when it changes) and the details below it.
 * The web page, the JSON and any future app all render these lines; nobody re-words them.
 */
export function describeShareView(v: ShareView): { headline: string; details: string[] } {
  const who = v.driver?.firstName ? v.driver.firstName : 'The driver';
  const details: string[] = [];
  let headline: string;

  switch (v.status) {
    case 'SEARCHING':
      headline = 'Looking for a driver.';
      break;
    case 'DRIVER_EN_ROUTE':
      headline = `${who} is on the way to pick up the rider.`;
      break;
    case 'DRIVER_ARRIVED':
      headline = `${who} has arrived at the pickup.`;
      break;
    case 'IN_PROGRESS':
      headline = 'The trip is under way.';
      break;
    case 'COMPLETED':
      headline = 'This trip is complete.';
      break;
    case 'CANCELLED':
      headline = 'This trip was cancelled.';
      break;
    case 'NO_DRIVERS':
      headline = 'No driver was found for this trip.';
      break;
  }

  if (!v.ended) {
    if (v.distanceMeters !== null && v.distanceTo) {
      details.push(
        v.distanceTo === 'pickup'
          ? `The driver is ${formatDistance(v.distanceMeters)} from the pickup.`
          : `${formatDistance(v.distanceMeters)} to the destination.`,
      );
    }
    if (v.etaSeconds !== null)
      details.push(`Estimated arrival in ${formatDuration(v.etaSeconds)}.`);
    if (v.waitingSeconds !== null) {
      details.push(`The driver has waited ${formatElapsed(v.waitingSeconds)}.`);
    }
    if (v.location?.placeName) details.push(`Last seen near ${v.location.placeName}.`);
    if (v.location && v.location.freshness !== 'live') {
      details.push('The driver location may be delayed.');
    }
  }
  if (v.driver?.vehicle) {
    details.push(
      `Vehicle: ${v.driver.vehicle}${v.driver.registration ? `, registration ${v.driver.registration}` : ''}.`,
    );
  }
  details.push(`Destination: ${v.destination.name}.`);
  return { headline, details };
}
