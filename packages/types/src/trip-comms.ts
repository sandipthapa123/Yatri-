import type { TripEventRecord } from './trip-events';
import type { TripRole } from './trip';

/** Trip chat and calling definitions — the one place their limits, states and shapes live. */

export const CHAT_MAX_LENGTH = 1000;

export interface ChatMessage {
  id: string;
  tripId: string;
  /** Per-trip, gap-free, monotonic — the ordering key. */
  seq: number;
  senderRole: TripRole;
  body: string;
  /** Client-generated id for de-duplicating retries; echoed back to the sender. */
  clientMessageId: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

/** A chat timeline entry: a person's message, or a system message rendered from a trip event. */
export type ChatTimelineItem =
  | { kind: 'message'; at: string; message: ChatMessage }
  | { kind: 'system'; at: string; event: TripEventRecord };

export interface ChatHistory {
  items: ChatTimelineItem[];
  /** Messages from the other party this viewer has not read yet. */
  unreadCount: number;
  canSend: boolean;
  /** Why sending is blocked, in words, when it is. */
  closedReason: string | null;
}

export const CALL_KINDS = ['AUDIO', 'VIDEO'] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export const CALL_STATES = ['RINGING', 'CONNECTING', 'CONNECTED', 'ENDED'] as const;
export type CallState = (typeof CALL_STATES)[number];

export const CALL_END_REASONS = [
  'COMPLETED',
  'DECLINED',
  'MISSED',
  'CANCELLED',
  'FAILED',
  'TRIP_ENDED',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

export interface CallInfo {
  id: string;
  tripId: string;
  kind: CallKind;
  state: CallState;
  callerRole: TripRole;
  createdAt: string;
  answeredAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  endReason: CallEndReason | null;
}

/** Opaque WebRTC signalling payloads relayed by the server; it never inspects the SDP. */
export type CallSignal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: Record<string, unknown> };

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** ICE servers handed to a call participant. TURN credentials are short-lived and per call. */
export interface IceServersResponse {
  iceServers: IceServer[];
  ttlSeconds: number;
}
