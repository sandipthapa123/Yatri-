import type { LiveTripSnapshot, ServerRealtimeMessage, TripEventName } from '@yatri/types';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'closed';

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface LocationSample {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  deviceTimeMs: number;
}

export interface RealtimeClientOptions {
  url: string;
  tripId: string;
  /** Returns a currently valid access token (refreshing if needed); throws when signed out. */
  getToken: () => Promise<string>;
  onSnapshot: (snapshot: LiveTripSnapshot) => void;
  onEvent?: (e: { event: TripEventName; important: boolean; eventId: number }) => void;
  onConnection: (state: ConnectionState) => void;
  onRejected?: (reason: string) => void;
  /** Injectable for tests. */
  createSocket?: (url: string) => WebSocketLike;
  now?: () => number;
  /** Backoff tuning. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}

const OPEN = 1;
const TOKEN_REFRESH_MS = 10 * 60_000;
const PING_MS = 20_000;
const SILENCE_LIMIT_MS = 45_000;
const MIN_SEND_INTERVAL_MS = 1000;
const MAX_QUEUED_AGE_MS = 25_000;

/**
 * Framework-free realtime trip client. It owns the hard parts so screens
 * don't: authenticating over the socket (never in the URL), resubscribing
 * after every reconnect (the server replies with full current state, so no
 * replay is needed), backing off with jitter, spotting half-open
 * connections, refreshing the token on a long-lived socket, dropping
 * duplicate/out-of-order snapshots, and keeping only the LATEST location
 * while offline (a stale queue of old positions is worse than none).
 */
export class TripRealtimeClient {
  private socket: WebSocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  private subscribed = false;
  private lastEventId = -1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private tokenTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private lastSentAt = 0;
  private pending: {
    kind: 'driver_location' | 'passenger_location';
    sample: LocationSample;
  } | null = null;
  private state: ConnectionState = 'connecting';

  constructor(private readonly opts: RealtimeClientOptions) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private setState(s: ConnectionState) {
    if (this.state === s) return;
    this.state = s;
    this.opts.onConnection(s);
  }

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.teardown();
    this.setState('closed');
  }

  private teardown() {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000);
      } catch {
        /* already closed */
      }
    }
  }

  /** Latest-wins: while offline only the newest sample is kept, and it expires. */
  sendLocation(kind: 'driver_location' | 'passenger_location', sample: LocationSample) {
    this.pending = { kind, sample };
    this.flush();
  }

  stopSharing() {
    this.raw({ type: 'stop_sharing', tripId: this.opts.tripId });
  }

  private flush() {
    const p = this.pending;
    if (!p || !this.subscribed || !this.socket || this.socket.readyState !== OPEN) return;
    if (this.now() - p.sample.deviceTimeMs > MAX_QUEUED_AGE_MS) {
      this.pending = null; // too old to be useful; the server would reject it as stale anyway
      return;
    }
    if (this.now() - this.lastSentAt < MIN_SEND_INTERVAL_MS) return; // next sample supersedes
    this.lastSentAt = this.now();
    this.pending = null;
    this.raw({
      type: p.kind,
      tripId: this.opts.tripId,
      latitude: p.sample.latitude,
      longitude: p.sample.longitude,
      accuracyMeters: p.sample.accuracyMeters,
      deviceTimeMs: p.sample.deviceTimeMs,
    });
  }

  private raw(message: object) {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private open() {
    if (this.stopped) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    this.subscribed = false;
    const socket = (
      this.opts.createSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike)
    )(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      void this.authenticate(socket);
      this.startTimers();
    };
    socket.onmessage = (ev) => {
      this.lastMessageAt = this.now();
      this.handle(String(ev.data), socket);
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.subscribed = false;
      if (this.stopped || this.state === 'ended') return;
      this.scheduleReconnect(ev.code);
    };
    socket.onerror = () => {
      /* onclose follows; reconnect logic lives there */
    };
  }

  private async authenticate(socket: WebSocketLike) {
    try {
      const token = await this.opts.getToken();
      if (this.socket === socket && socket.readyState === OPEN) {
        socket.send(JSON.stringify({ type: 'auth', token }));
      }
    } catch {
      // Signed out or token refresh impossible: stop instead of hammering the server.
      this.stopped = true;
      this.setState('closed');
      socket.close(1000);
    }
  }

  private handle(raw: string, socket: WebSocketLike) {
    let msg: ServerRealtimeMessage;
    try {
      msg = JSON.parse(raw) as ServerRealtimeMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'authed':
        if (!this.subscribed)
          socket.send(JSON.stringify({ type: 'subscribe', tripId: this.opts.tripId }));
        break;
      case 'subscribed':
        this.subscribed = true;
        this.attempt = 0;
        this.setState('live');
        this.flush();
        break;
      case 'snapshot': {
        // Duplicates and late arrivals must not roll the UI backwards. Equal ids are allowed
        // (place-name enrichment can re-issue the same state), older ones are dropped.
        if (msg.snapshot.eventId < this.lastEventId) return;
        this.lastEventId = msg.snapshot.eventId;
        this.opts.onSnapshot(msg.snapshot);
        break;
      }
      case 'event':
        this.opts.onEvent?.({ event: msg.event, important: msg.important, eventId: msg.eventId });
        break;
      case 'rejected':
        this.opts.onRejected?.(msg.reason);
        break;
      case 'error':
        if (msg.code === 'NOT_FOUND') {
          // The trip is over (or was never ours): stop reconnecting.
          this.teardown();
          this.setState('ended');
        }
        break;
      default:
        break;
    }
  }

  private scheduleReconnect(closeCode?: number) {
    const base = this.opts.baseDelayMs ?? 500;
    const max = this.opts.maxDelayMs ?? 30_000;
    const rnd = (this.opts.random ?? Math.random)();
    const delay = Math.min(max, base * 2 ** this.attempt) * (0.5 + rnd / 2); // jittered
    this.attempt++;
    this.setState('reconnecting');
    void closeCode;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private startTimers() {
    this.clearTimers();
    this.lastMessageAt = this.now();
    this.pingTimer = setInterval(() => {
      if (this.now() - this.lastMessageAt > SILENCE_LIMIT_MS) {
        // Half-open connection (no traffic, no close event): force a reconnect.
        this.socket?.close(4000);
        return;
      }
      this.raw({ type: 'ping' });
    }, PING_MS);
    this.tokenTimer = setInterval(() => {
      if (this.socket) void this.authenticate(this.socket);
    }, TOKEN_REFRESH_MS);
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    this.reconnectTimer = this.pingTimer = this.tokenTimer = null;
  }
}

/** ws(s):// URL for the realtime endpoint, derived from the REST base unless overridden. */
export function realtimeUrlFrom(apiBaseUrl: string, override?: string): string {
  if (override) return override;
  const u = apiBaseUrl.replace(/\/api\/v\d+\/?$/, '');
  return `${u.replace(/^http/, 'ws')}/ws/v1/realtime`;
}
