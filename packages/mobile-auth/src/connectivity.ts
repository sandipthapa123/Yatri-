/**
 * What the app knows about its own connection to Yatri. It is a measurement, never a guess: the one request function
 * reports every network success and failure here, so "offline" means "the last requests could not reach the server".
 * Nothing about a ride is decided from it; it only lets the screens say, in words, that what they show may be out of
 * date. Framework-free so it is tested without a device; the banner that renders it is in @yatri/mobile-ride.
 */
export type ConnectivityStatus = 'online' | 'offline';

export interface ConnectivityState {
  status: ConnectivityStatus;
  /** When the current status began (device clock, ms). */
  since: number;
  /** The last time the server answered (device clock, ms), or null if it has not yet. */
  lastOkAt: number | null;
  /** When we came back from offline (ms), so the screen can say "back online" for a moment. */
  recoveredAt: number | null;
  failures: number;
}

/** One failed request can be a blip; two in a row is treated as offline. */
export const OFFLINE_AFTER_FAILURES = 2;

type Listener = () => void;

export class ConnectivityMonitor {
  private state: ConnectivityState;
  private listeners = new Set<Listener>();

  constructor(private readonly now: () => number = Date.now) {
    this.state = { status: 'online', since: now(), lastOkAt: null, recoveredAt: null, failures: 0 };
  }

  getState = (): ConnectivityState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The server answered (with anything, including an error answer: the network works). */
  reportReachable = (): void => {
    const at = this.now();
    const wasOffline = this.state.status === 'offline';
    this.set({
      status: 'online',
      since: wasOffline ? at : this.state.since,
      lastOkAt: at,
      recoveredAt: wasOffline ? at : this.state.recoveredAt,
      failures: 0,
    });
  };

  /** A request could not reach the server at all. */
  reportUnreachable = (): void => {
    const failures = this.state.failures + 1;
    const offline = failures >= OFFLINE_AFTER_FAILURES;
    this.set({
      ...this.state,
      failures,
      status: offline ? 'offline' : this.state.status,
      since: offline && this.state.status !== 'offline' ? this.now() : this.state.since,
    });
  };

  private set(next: ConnectivityState): void {
    const changed =
      next.status !== this.state.status ||
      next.failures !== this.state.failures ||
      next.lastOkAt !== this.state.lastOkAt ||
      next.recoveredAt !== this.state.recoveredAt;
    this.state = next;
    if (changed) this.listeners.forEach((l) => l());
  }
}

/** The app's one monitor. */
export const connectivity = new ConnectivityMonitor();
