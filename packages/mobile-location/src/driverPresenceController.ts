import type {
  DriverAvailabilityStatus,
  DriverLocationSample,
  ServerRealtimeMessage,
} from '@yatri/types';

import type { ConnectionState, PresenceSample } from './realtimeClient';

export interface GpsFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  headingDegrees?: number | null;
  speedMps?: number | null;
  timestampMs: number;
  /** Platform says this reading is simulated (Android mock provider). Sent as a flag, never trusted. */
  mocked?: boolean;
}

export interface LocationAdapter {
  ensurePermission(): Promise<'granted' | 'denied' | 'blocked'>;
  servicesEnabled(): Promise<boolean>;
  getCurrent(): Promise<GpsFix>;
  watch(
    opts: { intervalMs: number; distanceMeters: number },
    onFix: (fix: GpsFix) => void,
  ): Promise<{ remove(): void }>;
}

export interface PresenceApi {
  online(sample: DriverLocationSample): Promise<DriverAvailabilityStatus>;
  offline(): Promise<DriverAvailabilityStatus>;
  status(): Promise<DriverAvailabilityStatus>;
}

/** The slice of the realtime client the controller needs (so tests can fake it). */
export interface PresenceClient {
  start(): void;
  stop(): void;
  sendPresenceLocation(sample: PresenceSample): void;
}

export type Phase = 'offline' | 'going-online' | 'online' | 'going-offline';

export interface PresenceState {
  phase: Phase;
  permission: 'unknown' | 'granted' | 'denied' | 'blocked';
  gps: 'idle' | 'acquiring' | 'ok' | 'weak' | 'lost' | 'unavailable';
  accuracyMeters: number | null;
  /** Local time of the last GPS reading. */
  lastFixAt: number | null;
  /** Local time the SERVER last confirmed it received a location. "Sharing" is only claimed from this. */
  lastAckAt: number | null;
  connection: ConnectionState;
  sharing: 'stopped' | 'confirmed' | 'delayed' | 'connection-lost';
  placeName: string | null;
  problem: { code: string; message: string; reasons?: string[] } | null;
  announcement: { id: number; text: string; assertive: boolean } | null;
  intervalMs: number;
  serverStatus: DriverAvailabilityStatus | null;
}

export interface PresenceOptions {
  location: LocationAdapter;
  api: PresenceApi;
  createClient: (h: {
    onConnection: (s: ConnectionState) => void;
    onMessage: (m: ServerRealtimeMessage) => void;
  }) => PresenceClient;
  reverseGeocode?: (fix: GpsFix) => Promise<string | null>;
  now?: () => number;
  maxAccuracyMeters?: number;
  acquireAttempts?: number;
  /** Delay between accuracy retries while acquiring the opening fix. */
  acquireRetryMs?: number;
}

const DEFAULT_INTERVAL_MS = 10_000;
const WATCHDOG_MS = 2_500;

const REASON_TEXT: Record<string, string> = {
  STALE_LOCATION:
    'You were taken offline because Yatri stopped receiving your location. Go online again when you are ready.',
  ACCOUNT_SUSPENDED: 'Your driver account was suspended. You are offline. Contact Yatri support.',
  ACCOUNT_DEACTIVATED: 'Your account was deactivated. You are offline.',
  TRANSITION_TIMEOUT: 'Going online did not finish, so you are offline. Please try again.',
};

/**
 * Everything about a driver being online, in one framework-free place: the
 * go-online sequence (permission -> accurate fix -> ask the SERVER -> only then
 * start sharing), battery-conscious updates at the server-configured cadence,
 * honest status (sharing is claimed only while the server keeps acknowledging),
 * and reacting when the server says something the app didn't expect (stale
 * timeout, suspension, another device). Screens just render its state.
 */
export class DriverPresenceController {
  private state: PresenceState = {
    phase: 'offline',
    permission: 'unknown',
    gps: 'idle',
    accuracyMeters: null,
    lastFixAt: null,
    lastAckAt: null,
    connection: 'closed',
    sharing: 'stopped',
    placeName: null,
    problem: null,
    announcement: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    serverStatus: null,
  };
  private listeners = new Set<() => void>();
  private client: PresenceClient | null = null;
  private watch: { remove(): void } | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private announceId = 0;
  private lastPlace: { latitude: number; longitude: number; atMs: number } | null = null;
  private disposed = false;

  constructor(private readonly opts: PresenceOptions) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getState = () => this.state;

  private now() {
    return (this.opts.now ?? Date.now)();
  }
  private set(patch: Partial<PresenceState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  private say(text: string, assertive = false) {
    this.set({ announcement: { id: ++this.announceId, text, assertive } });
  }

  dispose() {
    this.disposed = true;
    this.teardownTracking();
  }

  // ------------------------------------------------------------------ go online

  async goOnline(): Promise<void> {
    // Double taps and taps during a pending change are ignored, not queued.
    if (this.busy || this.state.phase !== 'offline') return;
    this.busy = true;
    this.set({ problem: null, gps: 'acquiring', phase: 'going-online' });
    try {
      const permission = await this.opts.location.ensurePermission();
      this.set({ permission });
      if (permission !== 'granted') {
        return this.failOnline(
          'PERMISSION',
          permission === 'blocked'
            ? 'Location is turned off for Yatri. Open your phone settings and allow location, then try again.'
            : 'Yatri needs your location to put you online. Allow location and try again.',
        );
      }
      if (!(await this.opts.location.servicesEnabled())) {
        this.set({ gps: 'unavailable' });
        return this.failOnline(
          'SERVICES_OFF',
          'Your phone’s location service is off. Turn it on and try again.',
        );
      }

      const fix = await this.acquireAccurateFix();
      if (!fix) return; // failOnline already called

      let status: DriverAvailabilityStatus;
      try {
        status = await this.opts.api.online(toSample(fix));
      } catch (err) {
        const e = err as { code?: string; message?: string; details?: { reasons?: string[] } };
        return this.failOnline(
          e.code ?? 'ONLINE_FAILED',
          e.code === 'NOT_ELIGIBLE'
            ? 'You cannot go online yet.'
            : (e.message ?? 'Could not go online. Check your connection and try again.'),
          e.details?.reasons,
        );
      }

      this.startTracking(status, fix);
      this.say('You are now online. Your location is being shared with Yatri.', true);
    } finally {
      this.busy = false;
    }
  }

  private failOnline(code: string, message: string, reasons?: string[]) {
    this.set({
      phase: 'offline',
      gps: this.state.gps === 'unavailable' || this.state.gps === 'weak' ? this.state.gps : 'idle',
      problem: { code, message, reasons },
    });
    this.say(
      reasons && reasons.length > 0
        ? `${message} ${reasons.join(' ')} You are still offline.`
        : `${message} You are still offline.`,
      true,
    );
  }

  private async acquireAccurateFix(): Promise<GpsFix | null> {
    const max = this.opts.maxAccuracyMeters ?? 100;
    const attempts = this.opts.acquireAttempts ?? 3;
    let last: GpsFix | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        last = await this.opts.location.getCurrent();
      } catch {
        last = null;
      }
      if (last && last.accuracyMeters !== null && last.accuracyMeters <= max) {
        this.set({ gps: 'ok', accuracyMeters: last.accuracyMeters, lastFixAt: this.now() });
        return last;
      }
      if (i < attempts - 1 && this.opts.acquireRetryMs) {
        await new Promise((r) => setTimeout(r, this.opts.acquireRetryMs));
      }
    }
    if (!last) {
      this.set({ gps: 'unavailable' });
      this.failOnline(
        'GPS_UNAVAILABLE',
        'Your phone could not get a GPS reading. Move to an open area and try again.',
      );
    } else {
      this.set({ gps: 'weak', accuracyMeters: last.accuracyMeters });
      this.failOnline(
        'WEAK_GPS_ACCURACY',
        `GPS accuracy is too weak to go online (${last.accuracyMeters === null ? 'unknown' : `${Math.round(last.accuracyMeters)} meters`}, needs ${max} or better). Move to an open area and try again.`,
      );
    }
    return null;
  }

  // ------------------------------------------------------------------ tracking

  private startTracking(status: DriverAvailabilityStatus, opening: GpsFix) {
    const intervalMs = status.updateIntervalsMs.idle;
    this.set({
      phase: 'online',
      serverStatus: status,
      intervalMs,
      lastFixAt: this.now(),
      lastAckAt: this.now(), // the server just accepted the opening fix
      accuracyMeters: opening.accuracyMeters,
      gps: 'ok',
      sharing: 'confirmed',
      connection: 'connecting',
      problem: null,
    });
    void this.refreshPlace(opening);

    this.client = this.opts.createClient({
      onConnection: (connection) => {
        this.set({ connection });
        this.recomputeSharing();
      },
      onMessage: (m) => this.onServerMessage(m),
    });
    this.client.start();

    // Battery: the OS is asked for ONE reading per interval (and only after real movement),
    // at balanced accuracy — never continuous maximum-accuracy GPS.
    void this.opts.location
      .watch({ intervalMs, distanceMeters: 20 }, (fix) => this.onFix(fix))
      .then((sub) => {
        if (this.disposed || this.state.phase !== 'online') sub.remove();
        else this.watch = sub;
      })
      .catch(() => this.set({ gps: 'unavailable' }));

    this.watchdog = setInterval(() => this.tick(), WATCHDOG_MS);
  }

  private onFix(fix: GpsFix) {
    if (this.state.phase !== 'online') return;
    const max = this.opts.maxAccuracyMeters ?? 100;
    this.set({
      lastFixAt: this.now(),
      accuracyMeters: fix.accuracyMeters,
      gps: fix.accuracyMeters === null || fix.accuracyMeters > max ? 'weak' : 'ok',
    });
    this.client?.sendPresenceLocation(toSample(fix));
    void this.refreshPlace(fix);
  }

  private async refreshPlace(fix: GpsFix) {
    if (!this.opts.reverseGeocode) return;
    const last = this.lastPlace;
    const moved = last ? distanceMeters(last, fix) : Infinity;
    // Reverse geocoding costs money: only after real movement and a pause.
    if (last && (moved < 150 || this.now() - last.atMs < 60_000)) return;
    this.lastPlace = { latitude: fix.latitude, longitude: fix.longitude, atMs: this.now() };
    try {
      const name = await this.opts.reverseGeocode(fix);
      if (name) this.set({ placeName: name });
    } catch {
      /* keep the previous name */
    }
  }

  /** Watchdog: derives honest GPS/sharing status from what has actually happened recently. */
  tick(nowMs = this.now()) {
    if (this.state.phase !== 'online') return;
    const interval = this.state.intervalMs;
    const gpsSilence = nowMs - (this.state.lastFixAt ?? nowMs);
    const gps =
      gpsSilence > Math.max(3 * interval, 20_000)
        ? ('lost' as const)
        : this.state.gps === 'lost'
          ? ('ok' as const)
          : this.state.gps;
    if (gps !== this.state.gps) this.set({ gps });
    this.recomputeSharing(nowMs);
  }

  private recomputeSharing(nowMs = this.now()) {
    if (this.state.phase !== 'online') return;
    const interval = this.state.intervalMs;
    let sharing: PresenceState['sharing'] = 'confirmed';
    if (this.state.connection !== 'live') sharing = 'connection-lost';
    else if (nowMs - (this.state.lastAckAt ?? 0) > Math.max(3 * interval, 30_000)) {
      sharing = 'delayed';
    }
    if (sharing !== this.state.sharing) {
      this.set({ sharing });
      if (sharing === 'connection-lost') {
        this.say('Connection lost. Your location is not being shared. Reconnecting.', true);
      } else if (sharing === 'delayed') {
        this.say('Location update delayed. Check your signal.');
      } else {
        this.say('Connection restored. Your location is being shared again.');
      }
    }
  }

  private onServerMessage(m: ServerRealtimeMessage) {
    switch (m.type) {
      case 'location_ack':
        this.set({ lastAckAt: this.now() });
        this.recomputeSharing();
        break;
      case 'availability': {
        this.set({ serverStatus: m.status });
        const s = m.status.state;
        if (this.state.phase === 'online' && s !== 'ONLINE' && s !== 'GOING_ONLINE') {
          this.stopLocal(
            REASON_TEXT[m.status.reason ?? ''] ??
              'The server took you offline. Go online again when you are ready.',
          );
        } else if (this.state.phase === 'online' && m.status.locationFreshness === 'stale') {
          this.recomputeSharing();
        }
        break;
      }
      case 'availability_error':
        this.set({ problem: { code: m.code, message: m.message } });
        break;
      case 'rejected':
        // 'not_online' means the server no longer considers us online.
        if (m.reason === 'not_online' && this.state.phase === 'online') {
          void this.resync();
        }
        break;
      case 'connection':
        if (m.status === 'superseded') {
          this.stopLocal('Another device took over your driver session, so you are offline here.');
        }
        break;
      default:
        break;
    }
  }

  /** Ask the server what is true and follow it. */
  async resync() {
    try {
      const status = await this.opts.api.status();
      this.set({ serverStatus: status });
      if (status.state !== 'ONLINE' && this.state.phase === 'online') {
        this.stopLocal(
          REASON_TEXT[status.reason ?? ''] ??
            'You are offline. Go online again when you are ready.',
        );
      }
    } catch {
      /* the watchdog keeps the status honest meanwhile */
    }
  }

  /**
   * App start: if the server already has this driver online (app restarted mid-shift),
   * pick the shift back up; otherwise just show the offline screen with eligibility.
   */
  async restore(): Promise<void> {
    try {
      const status = await this.opts.api.status();
      this.set({ serverStatus: status });
      if (status.state !== 'ONLINE' || this.state.phase !== 'offline') return;
      const permission = await this.opts.location.ensurePermission();
      this.set({ permission });
      if (permission !== 'granted') {
        await this.opts.api.offline().catch(() => undefined);
        return;
      }
      const fix = await this.opts.location.getCurrent();
      this.startTracking(status, fix);
      this.say('You are online. Your location is being shared with Yatri.');
    } catch {
      /* offline screen remains */
    }
  }

  // ------------------------------------------------------------------ go offline

  async goOffline(): Promise<void> {
    if (this.busy || this.state.phase !== 'online') return;
    this.busy = true;
    this.set({ phase: 'going-offline', problem: null });
    // Stop broadcasting FIRST: nothing should be sent after the driver chose to stop.
    this.teardownTracking();
    try {
      await this.opts.api.offline();
      this.set({ phase: 'offline', sharing: 'stopped', gps: 'idle', connection: 'closed' });
      this.say('You are now offline. Location sharing has stopped.', true);
    } catch {
      // Could not reach the server. Sharing has stopped locally; the server will time this
      // driver out on its own (stale handling), so they never stay online indefinitely.
      this.set({
        phase: 'offline',
        sharing: 'stopped',
        gps: 'idle',
        connection: 'closed',
        problem: {
          code: 'OFFLINE_UNCONFIRMED',
          message:
            'You are offline on this phone, but Yatri could not confirm it. You will be marked offline automatically shortly.',
        },
      });
      this.say(
        'You are now offline. Location sharing has stopped. Yatri could not confirm it yet; you will be marked offline automatically.',
        true,
      );
    } finally {
      this.busy = false;
    }
  }

  private stopLocal(message: string) {
    this.teardownTracking();
    this.set({ phase: 'offline', sharing: 'stopped', gps: 'idle', connection: 'closed' });
    this.say(message, true);
  }

  private teardownTracking() {
    this.watch?.remove();
    this.watch = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.client?.stop();
    this.client = null;
    this.lastPlace = null;
  }
}

function toSample(fix: GpsFix): DriverLocationSample {
  return {
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracyMeters: fix.accuracyMeters,
    headingDegrees: fix.headingDegrees ?? null,
    speedMps: fix.speedMps ?? null,
    deviceTimeMs: fix.timestampMs,
    ...(fix.mocked ? { mockLocation: true } : {}),
  };
}

function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
