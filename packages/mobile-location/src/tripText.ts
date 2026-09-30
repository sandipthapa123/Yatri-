import { formatDistance, formatDuration, formatElapsed } from '@yatri/types';
import type { Freshness, LiveTripSnapshot, TripStatus, WaitingInfo } from '@yatri/types';

import { formatAccuracy } from './format';

export { formatDuration };

export type Viewer = 'PASSENGER' | 'DRIVER';

/** "Driver is 85 meters away." / "Driver is very close." */
export function distancePhrase(subject: string, meters: number): string {
  if (meters <= 15) return `${subject} is very close.`;
  return `${subject} is ${formatDistance(meters)} away.`;
}

export function etaPhrase(kind: 'arrival' | 'trip', seconds: number | null): string | null {
  if (seconds === null) return null;
  return kind === 'arrival'
    ? `Estimated arrival in ${formatDuration(seconds)}.`
    : `Estimated time to destination: ${formatDuration(seconds)}.`;
}

export function placePhrase(
  subject: string,
  name: string | null,
  kind: 'road' | 'place' | null,
  verb: 'is' | 'are' = 'is',
): string | null {
  if (!name) return null;
  return kind === 'road' ? `${subject} ${verb} on ${name}.` : `${subject} ${verb} near ${name}.`;
}

export function ageText(ageSeconds: number): string {
  if (ageSeconds < 5) return 'just now';
  if (ageSeconds < 60) return `${Math.round(ageSeconds / 5) * 5} seconds ago`;
  return `${formatDuration(ageSeconds)} ago`;
}

export function freshnessPhrase(subject: string, freshness: Freshness, ageSeconds: number): string {
  switch (freshness) {
    case 'live':
      return `${subject} location updated ${ageText(ageSeconds)}.`;
    case 'stale':
      return `${subject} location may be delayed. Last updated ${ageText(ageSeconds)}.`;
    case 'lost':
      return `${subject} location signal lost. Last seen ${ageText(ageSeconds)}.`;
    default:
      return `${subject} location not available yet.`;
  }
}

export const STATUS_TEXT: Record<TripStatus, string> = {
  SEARCHING: 'Looking for a driver',
  NO_DRIVERS: 'No drivers available',
  DRIVER_EN_ROUTE: 'Driver is on the way',
  DRIVER_ARRIVED: 'Driver has arrived at the pickup',
  IN_PROGRESS: 'Trip in progress',
  COMPLETED: 'Trip completed',
  CANCELLED: 'Trip cancelled',
};

/**
 * Waiting as a label/value row. The seconds come from the server; this only words them.
 * Fare effect is stated in words so it is never conveyed by colour alone.
 */
export function waitingRow(w: WaitingInfo | null, viewer: Viewer): SummaryRow | null {
  if (!w) return null;
  if (w.driver) {
    const t = formatElapsed(w.driver.seconds);
    // The driver's screen also says the passenger knows (the server stamps when they were told).
    const told =
      viewer === 'DRIVER' && w.driver.notifiedAt ? ' The passenger has been notified.' : '';
    const fare =
      w.chargeNpr > 0
        ? ` Waiting charge so far: NPR ${w.chargeNpr}.`
        : w.driver.seconds < w.rule.freeSeconds
          ? ` Free waiting time remaining: ${formatElapsed(w.rule.freeSeconds - w.driver.seconds)}.`
          : '';
    return {
      label: viewer === 'DRIVER' ? 'You have been waiting' : 'Your driver has been waiting',
      value: `${t}.${fare}${told}`,
    };
  }
  if (w.passenger) {
    return {
      label: viewer === 'PASSENGER' ? 'You have been waiting' : 'The passenger has been waiting',
      value: `${formatElapsed(w.passenger.seconds)}. No waiting charge applies.`,
    };
  }
  return null;
}

export interface SummaryRow {
  label: string;
  value: string;
}

/**
 * The complete non-visual description of the trip as label/value rows.
 * Everything a map shows is here as text; the labels distinguish the three
 * time concepts (driver arrival, trip ETA, waiting time) so one is never
 * presented as another.
 */
export function summaryRows(s: LiveTripSnapshot, viewer: Viewer): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const other = viewer === 'PASSENGER' ? s.driver : s.passenger;
  const subject = viewer === 'PASSENGER' ? 'Driver' : 'Passenger';

  rows.push({
    label: viewer === 'PASSENGER' ? 'Driver’s current location' : 'Your current location',
    value: s.driver?.placeName
      ? s.driver.placeName
      : s.driver
        ? 'Place name temporarily unavailable'
        : 'Not available yet',
  });

  if (s.driverArrival) {
    rows.push({
      label: viewer === 'PASSENGER' ? 'Driver distance' : 'Distance to pickup',
      value: formatDistance(s.driverArrival.distanceMeters),
    });
    rows.push({
      label: 'Driver arrival ETA',
      value:
        s.driverArrival.etaSeconds === null
          ? 'Not available'
          : `${formatDuration(s.driverArrival.etaSeconds)}${s.driverArrival.basis === 'estimate' ? ' (estimate)' : ''}`,
    });
  }
  if (s.trip) {
    rows.push({
      label: 'Distance to destination',
      value: formatDistance(s.trip.distanceRemainingMeters),
    });
    rows.push({
      label: 'Trip ETA',
      value:
        s.trip.etaSeconds === null
          ? 'Not available'
          : `${formatDuration(s.trip.etaSeconds)}${s.trip.basis === 'estimate' ? ' (estimate)' : ''}`,
    });
  }
  const wait = waitingRow(s.waiting, viewer);
  if (wait) rows.push(wait);

  rows.push({ label: 'Trip status', value: STATUS_TEXT[s.status] });
  rows.push({
    label: 'Pickup',
    value: `${s.pickup.name}${s.pickup.address ? `, ${s.pickup.address}` : ''}`,
  });
  rows.push({
    label: 'Destination',
    value: `${s.destination.name}${s.destination.address ? `, ${s.destination.address}` : ''}`,
  });

  if (s.driver) {
    const acc = formatAccuracy(s.driver.accuracyMeters);
    if (acc)
      rows.push({
        label: 'Location accuracy',
        value: acc.replace(/^Location accuracy /, '').replace(/\.$/, ''),
      });
    rows.push({
      label: 'Last location update',
      value: `${ageText(s.driver.ageSeconds)}${s.driver.freshness === 'live' ? '' : ` (${s.driver.freshness === 'stale' ? 'delayed' : 'signal lost'})`}`,
    });
  }
  if (other && viewer === 'DRIVER' && s.passenger) {
    rows.push({
      label: `${subject}'s location`,
      value: s.passenger.placeName
        ? `Near ${s.passenger.placeName}`
        : 'Shared, place name unavailable',
    });
  }
  return rows;
}

/**
 * One sentence-group for the live region, in the order a listener needs it:
 * how far, how long, where. e.g. "Driver is 180 meters away. Estimated
 * arrival in 2 minutes. Driver is on New Road."
 */
export function liveSentence(s: LiveTripSnapshot, viewer: Viewer): string {
  if (s.status === 'COMPLETED') return 'Trip completed. You have reached your destination.';
  if (s.status === 'CANCELLED') return 'Trip cancelled.';
  const parts: string[] = [];

  if (s.status === 'DRIVER_ARRIVED') {
    parts.push(
      viewer === 'PASSENGER'
        ? 'Driver has arrived at the pickup.'
        : 'You have arrived at the pickup.',
    );
  } else if (s.driverArrival) {
    parts.push(
      viewer === 'PASSENGER'
        ? distancePhrase('Driver', s.driverArrival.distanceMeters)
        : `Pickup is ${formatDistance(s.driverArrival.distanceMeters)} away.`,
    );
    const eta = etaPhrase('arrival', s.driverArrival.etaSeconds);
    if (eta) parts.push(eta);
  } else if (s.trip) {
    parts.push(`${formatDistance(s.trip.distanceRemainingMeters)} to destination.`);
    const eta = etaPhrase('trip', s.trip.etaSeconds);
    if (eta) parts.push(eta);
  }

  const place = s.driver
    ? placePhrase(
        viewer === 'PASSENGER' ? 'Driver' : 'You',
        s.driver.placeName,
        s.driver.placeKind,
        viewer === 'PASSENGER' ? 'is' : 'are',
      )
    : null;
  if (place) parts.push(place);
  return parts.join(' ');
}
