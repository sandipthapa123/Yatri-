import type { SpokenMessage } from '@yatri/mobile-location';
import {
  describeSosStatus,
  OPEN_SOS_STATES,
  type ServerRealtimeMessage,
  type SosInfo,
  type SosRequestBody,
} from '@yatri/types';

import type { ServerMessageBus } from './rideSocket';

export interface SosState {
  sos: SosInfo | null;
  busy: 'sending' | 'cancelling' | null;
  error: string | null;
  /** Critical news, read out at once. */
  assertive: SpokenMessage | null;
}

export interface SosControllerOptions {
  tripId: string;
  socket: ServerMessageBus;
  api: {
    mine(): Promise<SosInfo | null>;
    raise(body: SosRequestBody): Promise<SosInfo>;
    cancel(): Promise<SosInfo>;
  };
  /** A quick position, or null. Must never wait long: an emergency is not held up for GPS. */
  getPosition?: () => Promise<{
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
  } | null>;
}

/** What is said when raising the alert fails: the fallback is always the phone call. */
export const SOS_FAILED_TEXT = (emergencyNumber: string) =>
  `The alert could not be sent. Call ${emergencyNumber} now, then try again.`;

/**
 * The person's own emergency alert. The server owns every state; this only asks and listens:
 * `sos_state` messages arrive for this person (and only them), and a reconnect re-reads the alert
 * so a change that happened while offline is not lost. Pressing twice can never make two alerts —
 * the server has one open alert per person per ride, and this refuses a second press in flight.
 */
export class SosController {
  private state: SosState = { sos: null, busy: null, error: null, assertive: null };
  private listeners = new Set<() => void>();
  private unsubs: Array<() => void> = [];
  private messageId = 0;
  private lastSpoken = '';
  private everLive = false;

  constructor(private readonly opts: SosControllerOptions) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getState = () => this.state;

  start() {
    this.unsubs.push(
      this.opts.socket.onMessage((m) => this.onSocket(m)),
      this.opts.socket.onConnectionChange((c) => {
        if (c !== 'live') return;
        void this.refresh(this.everLive);
        this.everLive = true;
      }),
    );
    void this.refresh(false);
  }

  stop() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.listeners.clear();
  }

  /** Raise the alert. Returns whether it is now on record. */
  async raise(): Promise<boolean> {
    if (this.state.busy || this.isOpen()) return this.isOpen();
    this.set({ busy: 'sending', error: null });
    try {
      const fix = (await this.opts.getPosition?.().catch(() => null)) ?? null;
      const sos = await this.opts.api.raise(
        fix
          ? { latitude: fix.latitude, longitude: fix.longitude, accuracyMeters: fix.accuracyMeters }
          : {},
      );
      this.apply(sos, true);
      this.set({ busy: null });
      return true;
    } catch {
      // Never a silent failure: say so, and point at the phone call.
      const text = SOS_FAILED_TEXT(this.state.sos?.emergencyNumber ?? '100');
      this.set({ busy: null, error: text, assertive: this.say(text) });
      return false;
    }
  }

  /** "I am safe": cancel my own alert. */
  async cancel(): Promise<boolean> {
    if (this.state.busy || !this.isOpen()) return false;
    this.set({ busy: 'cancelling', error: null });
    try {
      this.apply(await this.opts.api.cancel(), true);
      this.set({ busy: null });
      return true;
    } catch {
      this.set({ busy: null, error: 'Could not cancel the alert. Please try again.' });
      return false;
    }
  }

  private isOpen() {
    return this.state.sos !== null && OPEN_SOS_STATES.includes(this.state.sos.status);
  }

  private onSocket(m: ServerRealtimeMessage) {
    if (m.type === 'sos_state' && m.sos.tripId === this.opts.tripId) this.apply(m.sos, true);
  }

  private async refresh(announce: boolean) {
    try {
      const sos = await this.opts.api.mine();
      if (sos) this.apply(sos, announce);
    } catch {
      /* the socket will push changes */
    }
  }

  /** Adopt the server's alert; speak a status once, however many ways it reaches us. */
  private apply(sos: SosInfo, announce: boolean) {
    const key = `${sos.id}:${sos.status}`;
    const speak = announce && key !== this.lastSpoken;
    this.lastSpoken = key;
    this.set({
      sos,
      error: null,
      ...(speak ? { assertive: this.say(describeSosStatus(sos)) } : {}),
    });
  }

  private say(text: string): SpokenMessage {
    return { id: ++this.messageId, text };
  }

  private set(patch: Partial<SosState>) {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
}
