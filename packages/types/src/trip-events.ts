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
] as const;
export type TripEventType = (typeof TRIP_EVENT_TYPES)[number];

export interface TripEventMeta {
  /** Announced assertively (interrupts) — arrivals, start/end, cancellations, loss of signal. */
  important: boolean;
  /** Shown to participants as a system message in the trip chat. */
  chatVisible: boolean;
}

const meta = (important: boolean, chatVisible: boolean): TripEventMeta => ({
  important,
  chatVisible,
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
  }
}

/** Heading text for a location update ("north-east"), so direction is available as words. */
export function describeHeading(headingDegrees: number | null): string | null {
  return headingDegrees === null ? null : `heading ${compassWord(headingDegrees)}`;
}
