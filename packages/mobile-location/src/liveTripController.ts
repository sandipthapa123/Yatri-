import type { LiveTripSnapshot } from '@yatri/types';

import {
  decideAnnouncement,
  INITIAL_ANNOUNCE_STATE,
  type AnnounceState,
} from './announcementPolicy';
import {
  TripRealtimeClient,
  type ConnectionState,
  type RealtimeClientOptions,
} from './realtimeClient';
import type { Viewer } from './tripText';

/** A spoken message. `id` changes every time so an identical repeat is still announced. */
export interface SpokenMessage {
  id: number;
  text: string;
}

export interface LiveTripState {
  snapshot: LiveTripSnapshot | null;
  /** Local clock time the snapshot arrived — lets the UI age "last update" without a request. */
  receivedAtMs: number | null;
  connection: ConnectionState;
  connectionNotice: string;
  polite: SpokenMessage | null;
  assertive: SpokenMessage | null;
  rejection: string | null;
}

export interface LiveTripControllerOptions {
  tripId: string;
  viewer: Viewer;
  getToken: () => Promise<string>;
  url: string;
  /** Optional REST snapshot used to paint immediately while the socket connects. */
  fetchInitial?: () => Promise<LiveTripSnapshot>;
  now?: () => number;
  createSocket?: RealtimeClientOptions['createSocket'];
  baseDelayMs?: number;
}

/**
 * Owns one trip's live state: the socket, snapshot ordering, and the
 * accessibility announcement decisions. UI code subscribes to it; nothing
 * about *when to speak* lives in components.
 */
export class LiveTripController {
  readonly client: TripRealtimeClient;
  private state: LiveTripState = {
    snapshot: null,
    receivedAtMs: null,
    connection: 'connecting',
    connectionNotice: '',
    polite: null,
    assertive: null,
    rejection: null,
  };
  private listeners = new Set<() => void>();
  private announce: AnnounceState = INITIAL_ANNOUNCE_STATE;
  private messageId = 0;
  private lastEventId = -1;
  private wasReconnecting = false;
  private cancelled = false;

  constructor(private readonly opts: LiveTripControllerOptions) {
    this.client = new TripRealtimeClient({
      url: opts.url,
      tripId: opts.tripId,
      getToken: opts.getToken,
      onSnapshot: (s) => this.apply(s),
      onConnection: (connection) => this.onConnection(connection),
      onRejected: (reason) => this.set({ rejection: reason }),
      now: opts.now,
      createSocket: opts.createSocket,
      baseDelayMs: opts.baseDelayMs,
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;

  start() {
    this.cancelled = false;
    if (this.opts.fetchInitial) {
      void this.opts
        .fetchInitial()
        .then((s) => {
          if (!this.cancelled) this.apply(s);
        })
        .catch(() => undefined); // the socket will deliver the snapshot
    }
    this.client.start();
  }

  stop() {
    this.cancelled = true;
    this.client.stop();
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private set(patch: Partial<LiveTripState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private apply(s: LiveTripSnapshot) {
    if (s.eventId < this.lastEventId) return; // late or duplicate; never roll the UI backwards
    this.lastEventId = s.eventId;
    const now = this.now();
    const { announcement, next } = decideAnnouncement(this.announce, s, now, this.opts.viewer);
    this.announce = next;
    this.set({
      snapshot: s,
      receivedAtMs: now,
      ...(announcement.polite
        ? { polite: { id: ++this.messageId, text: announcement.polite } }
        : {}),
      ...(announcement.assertive
        ? { assertive: { id: ++this.messageId, text: announcement.assertive } }
        : {}),
    });
  }

  private onConnection(connection: ConnectionState) {
    if (connection === 'reconnecting') {
      this.wasReconnecting = true;
      this.set({ connection, connectionNotice: 'Live updates interrupted. Reconnecting.' });
    } else if (connection === 'live' && this.wasReconnecting) {
      this.wasReconnecting = false;
      this.set({ connection, connectionNotice: 'Live updates restored.' });
    } else {
      this.set({ connection });
    }
  }
}
