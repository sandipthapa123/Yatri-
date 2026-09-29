import {
  TRIP_EVENT_META,
  describeTripEvent,
  type LiveTripSnapshot,
  type ServerRealtimeMessage,
  type TripEventRecord,
} from '@yatri/types';

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
  /** Every domain event applied so far, in seq order (each seq exactly once). */
  events: TripEventRecord[];
}

export interface LiveTripControllerOptions {
  tripId: string;
  viewer: Viewer;
  getToken: () => Promise<string>;
  url: string;
  /** Optional REST snapshot used to paint immediately while the socket connects. */
  fetchInitial?: () => Promise<LiveTripSnapshot>;
  /** REST event list (events with seq > afterSeq): initial history and gap/reconnect catch-up. */
  fetchEvents?: (afterSeq: number) => Promise<TripEventRecord[]>;
  now?: () => number;
  createSocket?: RealtimeClientOptions['createSocket'];
  baseDelayMs?: number;
}

/**
 * Events the announcement pipeline does not read out because a snapshot-driven sentence already
 * carries the same information (distance changes) — reading both would say it twice.
 */
const SPOKEN_BY_SNAPSHOT_POLICY = new Set<TripEventRecord['type']>(['DRIVER_NEARBY']);

/**
 * Owns one trip's live state: the socket, snapshot ordering, domain events, and the
 * accessibility announcement decisions. UI code subscribes to it; nothing about *when to speak*
 * lives in components. Two sources speak, each for its own kind of information:
 *  - server events (worded by describeTripEvent): phase changes, waiting milestones, signal loss;
 *  - snapshots (announcementPolicy): distance / ETA / place changes.
 * The same socket is shared with chat and calls through `onMessage`.
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
    events: [],
  };
  private listeners = new Set<() => void>();
  private messageListeners = new Set<(m: ServerRealtimeMessage) => void>();
  private connectionListeners = new Set<(c: ConnectionState) => void>();
  private announce: AnnounceState = INITIAL_ANNOUNCE_STATE;
  private messageId = 0;
  private lastVersion = -1;
  private lastEventSeq = 0;
  private wasReconnecting = false;
  private cancelled = false;
  private catchingUp = false;

  constructor(private readonly opts: LiveTripControllerOptions) {
    this.client = new TripRealtimeClient({
      url: opts.url,
      tripId: opts.tripId,
      getToken: opts.getToken,
      onSnapshot: (s) => this.apply(s),
      onEvent: ({ event }) => this.onEvent(event),
      onMessage: (m) => {
        for (const l of this.messageListeners) l(m);
      },
      onConnection: (connection) => this.onConnection(connection),
      onRejected: (reason) => this.set({ rejection: reason }),
      now: opts.now,
      createSocket: opts.createSocket,
      baseDelayMs: opts.baseDelayMs,
    });
  }

  /** What chat and call controllers need from this trip's socket (a stable object). */
  readonly socket = {
    send: (m: object) => this.client.send(m),
    onMessage: (l: (m: ServerRealtimeMessage) => void) => this.onMessage(l),
    onConnectionChange: (l: (c: string) => void) => this.onConnectionChange(l),
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;

  /** Every server message (chat, calls, receipts, events…) — one socket, many consumers. */
  onMessage = (listener: (m: ServerRealtimeMessage) => void) => {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  };
  /** Connection changes, so chat/calls can catch up over REST after a reconnect. */
  onConnectionChange = (listener: (c: ConnectionState) => void) => {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  };

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
    // History is state, not news: what already happened is recorded silently.
    void this.catchUp(false);
    this.client.start();
  }

  stop() {
    this.cancelled = true;
    this.client.stop();
    this.messageListeners.clear();
    this.connectionListeners.clear();
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private set(patch: Partial<LiveTripState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private speak(texts: string[], assertive: boolean) {
    if (texts.length === 0) return;
    const text = texts.join(' ');
    this.set(
      assertive
        ? { assertive: { id: ++this.messageId, text } }
        : { polite: { id: ++this.messageId, text } },
    );
  }

  private apply(s: LiveTripSnapshot) {
    if (s.version < this.lastVersion) return; // late or duplicate; never roll the UI backwards
    this.lastVersion = s.version;
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

  /** A pushed event: apply it once, in order; a gap means something was missed — fetch it. */
  private onEvent(event: TripEventRecord) {
    if (event.seq <= this.lastEventSeq) return; // duplicate or replay
    if (event.seq > this.lastEventSeq + 1 && this.opts.fetchEvents) {
      void this.catchUp(true);
      return;
    }
    this.applyEvents([event], true);
  }

  private applyEvents(events: TripEventRecord[], announce: boolean) {
    const fresh = events.filter((e) => e.seq > this.lastEventSeq).sort((a, b) => a.seq - b.seq);
    if (fresh.length === 0) return;
    this.lastEventSeq = fresh[fresh.length - 1]!.seq;
    this.set({ events: [...this.state.events, ...fresh] });
    if (!announce) return;
    const spoken = fresh.filter((e) => !SPOKEN_BY_SNAPSHOT_POLICY.has(e.type));
    const important = spoken.filter((e) => TRIP_EVENT_META[e.type].important);
    // One announcement per batch: an assertive one when anything important happened.
    const batch = important.length > 0 ? important : spoken;
    this.speak(
      batch.map((e) => describeTripEvent(e, this.opts.viewer)),
      important.length > 0,
    );
  }

  private async catchUp(announce: boolean) {
    const fetchEvents = this.opts.fetchEvents;
    if (!fetchEvents || this.catchingUp) return;
    this.catchingUp = true;
    try {
      const events = await fetchEvents(this.lastEventSeq);
      if (!this.cancelled) this.applyEvents(events, announce);
    } catch {
      /* the next event or reconnect will trigger another catch-up */
    } finally {
      this.catchingUp = false;
    }
  }

  private onConnection(connection: ConnectionState) {
    for (const l of this.connectionListeners) l(connection);
    if (connection === 'reconnecting') {
      this.wasReconnecting = true;
      this.set({ connection, connectionNotice: 'Live updates interrupted. Reconnecting.' });
    } else if (connection === 'live' && this.wasReconnecting) {
      this.wasReconnecting = false;
      this.set({ connection, connectionNotice: 'Live updates restored.' });
      void this.catchUp(true); // anything that happened while offline
    } else {
      this.set({ connection });
    }
  }
}
