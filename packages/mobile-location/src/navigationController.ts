import {
  STEP_AHEAD_METERS,
  STEP_NOW_METERS,
  describeGuidance,
  nextStepSentence,
  type LiveTripSnapshot,
  type NavigationGuidance,
  type NavigationRoute,
  type NavigationRouteResponse,
} from '@yatri/types';

/**
 * The driver's navigation on the phone, with no framework in it so it is tested. The SERVER keeps the route, works out
 * the next maneuver, the phase and whether the driver is off the route; this only
 *  - fetches the route when the server says it changed (a different `routeVersion` in the live snapshot), once, and
 *    never while a fetch is already running (mobile data, and a flaky connection, are not for repeated requests);
 *  - keeps the last route when the network fails, and says so: directions that may be out of date are labelled, not hidden;
 *  - decides WHEN to speak: a new route, a confirmed deviation, an approaching maneuver, the arrival at the pickup.
 * It never computes a route, a distance to a turn, or whether the driver is off the road.
 */
export interface NavigationState {
  route: NavigationRoute | null;
  guidance: NavigationGuidance | null;
  /** The last attempt to fetch the route failed (offline), so what is shown may be old. */
  stale: boolean;
  /** A spoken message; `id` changes each time so an identical repeat is still announced. */
  polite: { id: number; text: string } | null;
}

export interface NavigationControllerOptions {
  /** Asks the server for the route; `version` is the one already held (an unchanged route is not resent). */
  fetchRoute: (version: number | null) => Promise<NavigationRouteResponse>;
  now?: () => number;
}

/** Guidance is spoken at most this often, except for a confirmed deviation. */
export const GUIDANCE_MIN_INTERVAL_MS = 4000;

export interface GuidanceMemory {
  routeVersion: number | null;
  offRoute: boolean;
  stepKey: string | null;
  atPickupSpoken: boolean;
  lastSpokenAtMs: number | null;
}
export const INITIAL_GUIDANCE_MEMORY: GuidanceMemory = {
  routeVersion: null,
  offRoute: false,
  stepKey: null,
  atPickupSpoken: false,
  lastSpokenAtMs: null,
};

/**
 * What to say now, if anything. Silent for GPS jitter: a maneuver is announced once when it comes within
 * STEP_AHEAD_METERS and once more within STEP_NOW_METERS; a new route and a confirmed deviation once each; the pickup
 * once. (Approaching and arriving at the DESTINATION, and the pickup's approach, are the ride's own events, spoken by the
 * live-trip pipeline, so they are not said twice here.)
 */
export function decideGuidanceAnnouncement(
  prev: GuidanceMemory,
  g: NavigationGuidance | null,
  nowMs: number,
  targetName: string,
): { text: string | null; next: GuidanceMemory } {
  if (!g) return { text: null, next: prev };
  const next: GuidanceMemory = { ...prev, routeVersion: g.routeVersion, offRoute: g.offRoute };
  const rateOk =
    prev.lastSpokenAtMs === null || nowMs - prev.lastSpokenAtMs >= GUIDANCE_MIN_INTERVAL_MS;
  const say = (text: string): { text: string; next: GuidanceMemory } => ({
    text,
    next: { ...next, lastSpokenAtMs: nowMs },
  });

  // A confirmed deviation is spoken at once (the driver should know), and only when it begins.
  if (g.offRoute && !prev.offRoute)
    return say('You are off the planned route. Finding a new route.');
  if (prev.routeVersion !== null && g.routeVersion !== prev.routeVersion && !g.offRoute) {
    const first = nextStepSentence(g);
    return say(`New route found. ${first ?? describeGuidance(g, targetName)}`);
  }
  if (!rateOk) return { text: null, next: { ...next, stepKey: prev.stepKey } };

  if (g.phase === 'AT_PICKUP' && !prev.atPickupSpoken) {
    return {
      text: 'You are at the pickup.',
      next: { ...next, atPickupSpoken: true, lastSpokenAtMs: nowMs },
    };
  }

  const step = g.next;
  if (step && step.maneuver !== 'straight' && step.maneuver !== 'other') {
    const level =
      step.distanceToManeuverMeters <= STEP_NOW_METERS
        ? 'now'
        : step.distanceToManeuverMeters <= STEP_AHEAD_METERS
          ? 'ahead'
          : null;
    if (level) {
      const key = `${g.routeVersion}:${step.index}:${level}`;
      // Each maneuver is said once at each distance, and "ahead" is not said again after "now".
      const alreadySaid =
        prev.stepKey === key ||
        (level === 'ahead' && prev.stepKey === `${g.routeVersion}:${step.index}:now`);
      if (!alreadySaid) {
        const text = nextStepSentence(g);
        if (text) return { text, next: { ...next, stepKey: key, lastSpokenAtMs: nowMs } };
      }
    }
  }
  return { text: null, next: { ...next, stepKey: prev.stepKey } };
}

type Listener = () => void;

export class NavigationController {
  private state: NavigationState = { route: null, guidance: null, stale: false, polite: null };
  private listeners = new Set<Listener>();
  private memory = INITIAL_GUIDANCE_MEMORY;
  private fetching = false;
  private wanted: number | null = null;
  private messageId = 0;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly opts: NavigationControllerOptions) {
    this.now = opts.now ?? Date.now;
  }

  getState = (): NavigationState => this.state;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /** Feed every live snapshot here. Cheap: it only acts when the server's route version is not the one held. */
  onSnapshot(s: LiveTripSnapshot | null): void {
    if (this.disposed) return;
    const g = s?.navigation ?? null;
    const target = s ? (g?.target === 'PICKUP' ? s.pickup.name : s.destination.name) : '';
    const decided = decideGuidanceAnnouncement(this.memory, g, this.now(), target);
    this.memory = decided.next;
    this.set({
      guidance: g,
      polite: decided.text ? { id: ++this.messageId, text: decided.text } : this.state.polite,
    });
    // `!==`, not `>`: after the server loses its cache the version starts again at 1, and that is still a new route.
    if (g && g.routeVersion !== this.state.route?.version) void this.load(g.routeVersion);
  }

  /** Ask again (the app came back to the foreground, or the connection returned). */
  refresh(): void {
    if (this.disposed) return;
    void this.load(this.state.guidance?.routeVersion ?? null, true);
  }

  private async load(wantedVersion: number | null, force = false): Promise<void> {
    if (this.fetching) {
      this.wanted = wantedVersion; // one request at a time; the newest wish is served next
      return;
    }
    this.fetching = true;
    try {
      const res = await this.opts.fetchRoute(force ? null : (this.state.route?.version ?? null));
      if (this.disposed) return;
      if (res.route) this.set({ route: res.route, stale: false });
      else this.set({ stale: false });
    } catch {
      if (!this.disposed) this.set({ stale: true }); // keep the old route, labelled as possibly out of date
    } finally {
      this.fetching = false;
      const again = this.wanted;
      this.wanted = null;
      if (
        !this.disposed &&
        again !== null &&
        again !== this.state.route?.version &&
        !this.state.stale
      ) {
        void this.load(again);
      }
    }
  }

  private set(patch: Partial<NavigationState>): void {
    const next = { ...this.state, ...patch };
    const changed =
      next.route !== this.state.route ||
      next.guidance !== this.state.guidance ||
      next.stale !== this.state.stale ||
      next.polite !== this.state.polite;
    this.state = next;
    if (changed) this.listeners.forEach((l) => l());
  }
}
