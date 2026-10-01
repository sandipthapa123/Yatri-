import { compassWord, formatDistance, formatElapsed, formatNpr } from './format';

/**
 * Domain events of a trip — the ONE definition. The server creates each event exactly once
 * (persisted, numbered per trip) and every client only consumes them: system chat messages,
 * screen-reader announcements, notifications and the admin timeline are all rendered from
 * these records through `describeTripEvent`. No app words or triggers an event itself.
 * Every event here is visible to the trip's participants (so their sequence has no gaps);
 * operational history (offers, disputes) lives in its own tables and the admin timeline merges it.
 */
export const TRIP_EVENT_TYPES = [
  'TRIP_REQUESTED',
  'DRIVER_REQUESTED',
  'DRIVER_DECLINED',
  'DRIVER_ASSIGNED',
  'DRIVER_NEARBY',
  'DRIVER_ARRIVED',
  'DRIVER_WAITING',
  'PASSENGER_WAITING',
  'TRIP_STARTED',
  'TRIP_COMPLETED',
  'TRIP_CANCELLED',
  'NO_DRIVERS_FOUND',
  'DRIVER_REMATCHING',
  'DRIVER_LOCATION_LOST',
  'DRIVER_LOCATION_RESTORED',
  'PAYMENT_RECEIVED',
  'CALL_MISSED',
  'TRIP_SHARE_STARTED',
  'TRIP_SHARE_STOPPED',
  'ACCESSIBILITY_UPDATED',
  'DESTINATION_NEARBY',
] as const;
export type TripEventType = (typeof TRIP_EVENT_TYPES)[number];

export interface TripEventMeta {
  /** Announced assertively (interrupts) — arrivals, start/end, cancellations, loss of signal. */
  important: boolean;
  /** Shown to participants as a system message in the trip chat. */
  chatVisible: boolean;
  /** Also delivered as a durable notification (by default, exactly the important ones). */
  notify: boolean;
}

const meta = (
  important: boolean,
  chatVisible: boolean,
  notify: boolean = important,
): TripEventMeta => ({
  important,
  chatVisible,
  notify,
});

export const TRIP_EVENT_META: Record<TripEventType, TripEventMeta> = {
  TRIP_REQUESTED: meta(false, false),
  DRIVER_REQUESTED: meta(false, false),
  DRIVER_DECLINED: meta(false, false),
  DRIVER_ASSIGNED: meta(true, true),
  DRIVER_NEARBY: meta(false, true),
  DRIVER_ARRIVED: meta(true, true),
  DRIVER_WAITING: meta(false, true),
  PASSENGER_WAITING: meta(false, true),
  TRIP_STARTED: meta(true, true),
  TRIP_COMPLETED: meta(true, true),
  TRIP_CANCELLED: meta(true, true),
  NO_DRIVERS_FOUND: meta(true, false),
  DRIVER_REMATCHING: meta(true, true),
  DRIVER_LOCATION_LOST: meta(true, false),
  DRIVER_LOCATION_RESTORED: meta(false, false),
  PAYMENT_RECEIVED: meta(false, true),
  CALL_MISSED: meta(false, true),
  // Sharing the trip is announced politely and notified: it is about the person's own safety.
  TRIP_SHARE_STARTED: meta(false, false, true),
  TRIP_SHARE_STOPPED: meta(false, false, true),
  // The passenger changed their pickup instructions: told politely, not by notification, and without the words
  // (the details are protected, so the event carries none; the driver reads them in the ride).
  ACCESSIBILITY_UPDATED: meta(false, false, false),
  // Approaching, near and at the destination: said politely to both people, once each, never as a notification.
  DESTINATION_NEARBY: meta(false, false, false),
};

export type TripEventPayload = Record<string, unknown>;

export interface TripEventRecord {
  tripId: string;
  /** Per-trip, gap-free, monotonic. Clients apply each seq once and ask for anything they missed. */
  seq: number;
  type: TripEventType;
  payload: TripEventPayload;
  createdAt: string;
}

export type EventViewer = 'PASSENGER' | 'DRIVER' | 'ADMIN';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * The words for an event, per audience. Used by the API (system chat messages, notifications),
 * by the apps (announcements) and by the admin timeline — one function, one wording.
 */
export function describeTripEvent(
  e: Pick<TripEventRecord, 'type' | 'payload'>,
  viewer: EventViewer,
): string {
  const p = e.payload;
  const isDriver = viewer === 'DRIVER';
  switch (e.type) {
    case 'TRIP_REQUESTED':
      return viewer === 'ADMIN'
        ? 'Ride requested.'
        : 'Ride requested. Looking for a nearby driver.';
    case 'DRIVER_REQUESTED': {
      const d = num(p.pickupDistanceMeters);
      const away = d === null ? '' : `, ${formatDistance(d)} away`;
      return viewer === 'ADMIN'
        ? `Ride offered to a driver${away}.`
        : `Driver found${away}. Waiting for the driver to accept.`;
    }
    case 'DRIVER_DECLINED':
      return viewer === 'ADMIN'
        ? `Driver ${str(p.reason) === 'EXPIRED' ? 'did not answer' : 'declined'}.`
        : 'That driver could not take your ride. Searching for another driver.';
    case 'DRIVER_ASSIGNED':
      return isDriver
        ? 'You have been assigned this ride.'
        : viewer === 'ADMIN'
          ? 'Driver accepted the ride.'
          : 'Driver has accepted your ride.';
    case 'DRIVER_NEARBY': {
      const d = num(p.distanceMeters);
      const away = d === null ? 'nearby' : `${formatDistance(d)} away`;
      return isDriver ? `The pickup is ${away}.` : `Driver is ${away}.`;
    }
    case 'DRIVER_ARRIVED':
      return isDriver
        ? 'You have arrived at the pickup.'
        : viewer === 'ADMIN'
          ? 'Driver arrived at the pickup.'
          : 'Your driver has arrived.';
    case 'DRIVER_WAITING': {
      const s = num(p.seconds);
      const t = s === null ? 'a while' : formatElapsed(s);
      return isDriver
        ? `You have been waiting for ${t}.`
        : viewer === 'ADMIN'
          ? `Driver has been waiting for ${t}.`
          : `Your driver has been waiting for ${t}.`;
    }
    case 'PASSENGER_WAITING': {
      const s = num(p.seconds);
      const t = s === null ? 'a while' : formatElapsed(s);
      return isDriver || viewer === 'ADMIN'
        ? `The passenger has been waiting for ${t}.`
        : `You have been waiting for ${t}.`;
    }
    case 'TRIP_STARTED':
      return isDriver || viewer === 'ADMIN' ? 'Ride started.' : 'Your ride has started.';
    case 'TRIP_COMPLETED': {
      const fare = num(p.fareNpr);
      const done =
        viewer === 'PASSENGER'
          ? 'Your ride is complete.'
          : viewer === 'ADMIN'
            ? 'Ride completed.'
            : 'Ride has ended.';
      return `${done}${fare !== null ? ` Fare: ${formatNpr(fare)}.` : ''}`;
    }
    case 'TRIP_CANCELLED': {
      const by = str(p.by);
      const who =
        by === 'PASSENGER'
          ? isDriver || viewer === 'ADMIN'
            ? 'the passenger'
            : 'you'
          : by === 'DRIVER'
            ? isDriver
              ? 'you'
              : 'the driver'
            : 'Yatri';
      const fee = num(p.feeNpr);
      const feeText =
        fee !== null && fee > 0 && !isDriver
          ? ` A cancellation fee of ${formatNpr(fee)} applies.`
          : '';
      return `The ride was cancelled by ${who}.${str(p.reason) ? ` Reason: ${str(p.reason)}.` : ''}${feeText}`;
    }
    case 'NO_DRIVERS_FOUND':
      return 'No drivers are available right now. Please try again in a moment.';
    case 'DRIVER_REMATCHING':
      return isDriver
        ? 'You are no longer assigned to this ride.'
        : viewer === 'ADMIN'
          ? 'The driver dropped out. Looking for another driver.'
          : 'Your driver is no longer available. Finding you another driver.';
    case 'DRIVER_LOCATION_LOST':
      return 'Driver location signal lost.';
    case 'DRIVER_LOCATION_RESTORED':
      return 'Driver location is back.';
    case 'PAYMENT_RECEIVED': {
      const a = num(p.amountNpr);
      return a === null ? 'Payment received.' : `Payment of ${formatNpr(a)} received.`;
    }
    case 'CALL_MISSED':
      return 'Missed call.';
    case 'TRIP_SHARE_STARTED':
      return viewer === 'PASSENGER'
        ? 'You are sharing this trip with a trusted contact.'
        : viewer === 'ADMIN'
          ? 'Trip sharing started.'
          : 'This trip is being shared with a trusted contact.';
    case 'TRIP_SHARE_STOPPED': {
      const why = str(p.reason);
      if (viewer !== 'PASSENGER')
        return viewer === 'ADMIN' ? 'Trip sharing ended.' : 'Trip sharing has ended.';
      return why === 'RIDE_ENDED'
        ? 'Trip sharing ended because the ride is over.'
        : why === 'EXPIRED'
          ? 'Trip sharing ended: the sharing period is over.'
          : 'You stopped sharing this trip.';
    }
    case 'DESTINATION_NEARBY': {
      const m = str(p.milestone);
      const d = num(p.distanceMeters);
      const away = d === null ? '' : ` About ${formatDistance(d)} to go.`;
      if (m === 'AT_DESTINATION') {
        return isDriver
          ? 'You have reached the destination. You can end the ride when the passenger is out.'
          : viewer === 'ADMIN'
            ? 'The vehicle reached the destination.'
            : 'You have reached your destination.';
      }
      if (m === 'NEAR_DESTINATION') {
        return isDriver
          ? `You are near the destination.${away}`
          : viewer === 'ADMIN'
            ? 'The vehicle is near the destination.'
            : `You are near your destination.${away}`;
      }
      return isDriver
        ? `You are approaching the destination.${away}`
        : viewer === 'ADMIN'
          ? 'The vehicle is approaching the destination.'
          : `You are approaching your destination.${away}`;
    }
    case 'ACCESSIBILITY_UPDATED':
      return isDriver
        ? 'The passenger updated their pickup instructions. Please read them again in the ride details.'
        : viewer === 'ADMIN'
          ? 'Pickup instructions were updated.'
          : 'Your pickup instructions were updated and your driver has been told.';
  }
}

/** Heading text for a location update ("north-east"), so direction is available as words. */
export function describeHeading(headingDegrees: number | null): string | null {
  return headingDegrees === null ? null : `heading ${compassWord(headingDegrees)}`;
}
