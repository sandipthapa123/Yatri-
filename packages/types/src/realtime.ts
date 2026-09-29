import type { DriverAvailabilityStatus, LocationFreshness } from './availability';
import type { LiveTripSnapshot } from './trip';
import type { TripOfferInfo } from './trip-commerce';
import type { CallInfo, CallKind, CallSignal, ChatMessage } from './trip-comms';
import type { TripEventRecord } from './trip-events';

/**
 * The realtime protocol (`/ws/v1/realtime`) — the one definition of every message either side
 * may send. ONE socket per app carries driver presence, trip snapshots, domain events, chat and
 * call signalling; there is no second channel and no per-feature state system.
 */

/** One GPS reading from the driver's device. Only what matching and fraud checks need. */
export interface DriverLocationSample {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  headingDegrees?: number | null;
  speedMps?: number | null;
  /** Device clock, ms. Used for ordering/staleness only; the server records its own receive time. */
  deviceTimeMs: number;
  /** Set when the platform reports a mocked/simulated location. Flagged, never trusted. */
  mockLocation?: boolean;
}

/** Client -> server. The authenticated connection is the identity: no message carries a user id. */
export type ClientRealtimeMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; tripId: string }
  | { type: 'unsubscribe'; tripId: string }
  /** Passenger location, trip-scoped and opt-in. (Driver location comes only from presence below.) */
  | {
      type: 'passenger_location';
      tripId: string;
      latitude: number;
      longitude: number;
      accuracyMeters?: number | null;
      deviceTimeMs: number;
    }
  | { type: 'stop_sharing'; tripId: string }
  /** Driver presence: also feeds the driver's active trip, so there is ONE driver-location path. */
  | ({ type: 'location' } & DriverLocationSample)
  | { type: 'availability'; action: 'online'; location: DriverLocationSample }
  | { type: 'availability'; action: 'offline' }
  | { type: 'chat_send'; tripId: string; clientMessageId: string; body: string }
  | { type: 'chat_read'; tripId: string; upToSeq: number }
  | { type: 'call_start'; tripId: string; kind: CallKind }
  | { type: 'call_answer'; callId: string }
  | { type: 'call_decline'; callId: string }
  | { type: 'call_end'; callId: string }
  | { type: 'call_connected'; callId: string }
  | { type: 'call_signal'; callId: string; signal: CallSignal }
  | { type: 'ping' };

/** Server -> client. */
export type ServerRealtimeMessage =
  | { type: 'authed'; userId: string; role: string }
  | { type: 'subscribed'; tripId: string }
  | { type: 'snapshot'; snapshot: LiveTripSnapshot }
  /** A persisted domain event. Apply each `seq` once; fetch the event list to fill any gap. */
  | { type: 'trip_event'; event: TripEventRecord; important: boolean }
  | { type: 'chat_message'; message: ChatMessage }
  | {
      type: 'chat_receipt';
      tripId: string;
      kind: 'delivered' | 'read';
      upToSeq: number;
      at: string;
    }
  | { type: 'trip_offer'; offer: TripOfferInfo }
  | {
      type: 'trip_offer_closed';
      offerId: string;
      reason: 'EXPIRED' | 'TAKEN' | 'CANCELLED' | 'DECLINED';
    }
  | { type: 'call_state'; call: CallInfo }
  | { type: 'call_signal'; callId: string; signal: CallSignal }
  | { type: 'rejected'; tripId: string; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | { type: 'availability'; status: DriverAvailabilityStatus }
  | { type: 'availability_error'; code: string; message: string }
  | {
      type: 'connection';
      status: 'connected' | 'superseded';
      updateIntervalMs: number;
    }
  | { type: 'location_ack'; receivedAt: string; freshness: LocationFreshness };
