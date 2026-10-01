import {
  describeGuidance,
  describeTripProgress,
  nextStepSentence,
  type LiveTripSnapshot,
  type NavigationGuidance,
  type NavigationRoute,
  type NavigationRouteResponse,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import {
  GUIDANCE_MIN_INTERVAL_MS,
  INITIAL_GUIDANCE_MEMORY,
  NavigationController,
  decideGuidanceAnnouncement,
} from './navigationController';

const guidance = (over: Partial<NavigationGuidance> = {}): NavigationGuidance => ({
  routeVersion: 1,
  target: 'PICKUP',
  phase: 'HEADING_TO_PICKUP',
  offRoute: false,
  deviationMeters: null,
  next: {
    index: 1,
    instruction: 'Turn left onto New Road.',
    maneuver: 'left',
    distanceToManeuverMeters: 900,
  },
  distanceRemainingMeters: 2400,
  etaSeconds: 420,
  basis: 'route',
  trafficAware: false,
  ...over,
});
const snapshot = (g: NavigationGuidance | null): LiveTripSnapshot => ({
  tripId: 't',
  status: 'DRIVER_EN_ROUTE',
  version: 1,
  lastEventSeq: 0,
  serverTime: new Date().toISOString(),
  pickup: { name: 'Thamel', address: 'Thamel, Kathmandu', latitude: 27.7, longitude: 85.3 },
  destination: { name: 'Patan', address: 'Patan', latitude: 27.6, longitude: 85.3 },
  driver: null,
  passenger: null,
  driverArrival: null,
  trip: null,
  waiting: null,
  navigation: g,
});
const route = (version: number): NavigationRoute => ({
  version,
  tripId: 't',
  target: 'PICKUP',
  distanceMeters: 2400,
  durationSeconds: 420,
  basis: 'route',
  trafficAware: false,
  geometry: [
    [27.7, 85.3],
    [27.71, 85.3],
  ],
  steps: [],
  plannedAt: new Date().toISOString(),
  provider: { name: 'fake', steps: true, traffic: false },
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('fetching the route', () => {
  it("fetches once when the server's route version is new, and not again for the same version", async () => {
    const asked: Array<number | null> = [];
    const c = new NavigationController({
      fetchRoute: async (v) => {
        asked.push(v);
        return { route: route(1), unchanged: false };
      },
    });
    c.onSnapshot(snapshot(guidance({ routeVersion: 1 })));
    await flush();
    c.onSnapshot(snapshot(guidance({ routeVersion: 1, distanceRemainingMeters: 2300 })));
    c.onSnapshot(snapshot(guidance({ routeVersion: 1, distanceRemainingMeters: 2200 })));
    await flush();
    expect(asked).toEqual([null]);
    expect(c.getState().route?.version).toBe(1);
  });

  it('fetches again when the server planned a new route, offering the version it holds', async () => {
    let n = 0;
    const asked: Array<number | null> = [];
    const c = new NavigationController({
      fetchRoute: async (v) => {
        asked.push(v);
        n += 1;
        return { route: route(n), unchanged: false };
      },
    });
    c.onSnapshot(snapshot(guidance({ routeVersion: 1 })));
    await flush();
    c.onSnapshot(snapshot(guidance({ routeVersion: 2 })));
    await flush();
    expect(asked).toEqual([null, 1]);
    expect(c.getState().route?.version).toBe(2);
  });

  it('treats a version that starts again from 1 (the server lost its cache) as a new route', async () => {
    let version = 3;
    const c = new NavigationController({
      fetchRoute: async () => ({ route: route(version), unchanged: false }),
    });
    c.onSnapshot(snapshot(guidance({ routeVersion: 3 })));
    await flush();
    version = 1;
    c.onSnapshot(snapshot(guidance({ routeVersion: 1 })));
    await flush();
    expect(c.getState().route?.version).toBe(1);
  });

  it('runs one request at a time, however many snapshots arrive meanwhile', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release: () => void = () => undefined;
    const c = new NavigationController({
      fetchRoute: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((r) => (release = r));
        inFlight -= 1;
        return { route: route(2), unchanged: false } satisfies NavigationRouteResponse;
      },
    });
    c.onSnapshot(snapshot(guidance({ routeVersion: 2 })));
    c.onSnapshot(snapshot(guidance({ routeVersion: 2 })));
    c.onSnapshot(snapshot(guidance({ routeVersion: 2 })));
    release();
    await flush();
    expect(maxInFlight).toBe(1);
  });

  it('keeps the last route and says directions may be out of date when the network fails, then recovers', async () => {
    let failing = false;
    const c = new NavigationController({
      fetchRoute: async () => {
        if (failing) throw new Error('offline');
        return { route: route(1), unchanged: false };
      },
    });
    c.onSnapshot(snapshot(guidance({ routeVersion: 1 })));
    await flush();
    failing = true;
    c.onSnapshot(snapshot(guidance({ routeVersion: 2 })));
    await flush();
    expect(c.getState().stale).toBe(true);
    expect(c.getState().route?.version).toBe(1); // not thrown away
    failing = false;
    c.refresh(); // the connection came back
    await flush();
    expect(c.getState().stale).toBe(false);
  });

  it('does nothing for a snapshot without guidance (the passenger, or no route yet)', async () => {
    let calls = 0;
    const c = new NavigationController({
      fetchRoute: async () => {
        calls += 1;
        return { route: null, unchanged: false };
      },
    });
    c.onSnapshot(snapshot(null));
    c.onSnapshot(null);
    await flush();
    expect(calls).toBe(0);
  });
});

describe('what is spoken, and when', () => {
  const run = (steps: Array<{ g: NavigationGuidance; at: number }>) => {
    let memory = INITIAL_GUIDANCE_MEMORY;
    const said: string[] = [];
    for (const s of steps) {
      const out = decideGuidanceAnnouncement(memory, s.g, s.at, 'Thamel');
      memory = out.next;
      if (out.text) said.push(out.text);
    }
    return said;
  };
  const near = (d: number, over: Partial<NavigationGuidance> = {}) =>
    guidance({
      next: {
        index: 1,
        instruction: 'Turn left onto New Road.',
        maneuver: 'left',
        distanceToManeuverMeters: d,
      },
      ...over,
    });

  it('says nothing while a turn is far away, however the readings move', () => {
    const t0 = 1_000_000;
    const said = run(
      Array.from({ length: 30 }, (_, i) => ({ g: near(900 - i * 3), at: t0 + i * 1000 })),
    );
    expect(said).toEqual([]);
  });

  it('says each turn once when it is ahead and once when it is now, never for jitter around the same distance', () => {
    const t0 = 1_000_000;
    const seq = [290, 288, 295, 280, 270, 250, 120, 118, 119, 60, 38, 36, 40, 35].map((d, i) => ({
      g: near(d),
      at: t0 + i * 6000,
    }));
    const said = run(seq);
    expect(said).toEqual([
      'In 290 meters, turn left onto New Road.',
      'Now, turn left onto New Road.',
    ]);
  });

  it('speaks a new route and a confirmed deviation once, and the deviation immediately', () => {
    const t0 = 2_000_000;
    const said = run([
      { g: near(900), at: t0 },
      { g: near(890, { offRoute: true }), at: t0 + 500 }, // right after: not held back by the interval
      { g: near(880, { offRoute: true }), at: t0 + 1500 }, // still off: not repeated
      { g: near(900, { routeVersion: 2 }), at: t0 + 9000 },
    ]);
    expect(said).toHaveLength(2);
    expect(said[0]).toBe('You are off the planned route. Finding a new route.');
    expect(said[1]).toMatch(/^New route found\./);
  });

  it('says "you are at the pickup" once', () => {
    const t0 = 3_000_000;
    const at = (n: number) => ({ g: guidance({ phase: 'AT_PICKUP' }), at: t0 + n * 10_000 });
    expect(run([at(0), at(1), at(2)])).toEqual(['You are at the pickup.']);
  });

  it('does not speak more often than the interval, except for a deviation', () => {
    const t0 = 4_000_000;
    const a = decideGuidanceAnnouncement(INITIAL_GUIDANCE_MEMORY, near(250), t0, 'x');
    expect(a.text).not.toBeNull();
    const b = decideGuidanceAnnouncement(
      a.next,
      near(35, {
        next: {
          index: 2,
          instruction: 'Turn right.',
          maneuver: 'right',
          distanceToManeuverMeters: 30,
        },
      }),
      t0 + GUIDANCE_MIN_INTERVAL_MS - 1,
      'x',
    );
    expect(b.text).toBeNull();
    const c = decideGuidanceAnnouncement(
      b.next,
      near(35, {
        next: {
          index: 2,
          instruction: 'Turn right.',
          maneuver: 'right',
          distanceToManeuverMeters: 30,
        },
      }),
      t0 + GUIDANCE_MIN_INTERVAL_MS + 1,
      'x',
    );
    expect(c.text).toBe('Now, turn right.');
  });

  it('is silent for "continue straight" and for no guidance', () => {
    const straight = guidance({
      next: {
        index: 1,
        instruction: 'Continue straight.',
        maneuver: 'straight',
        distanceToManeuverMeters: 100,
      },
    });
    expect(run([{ g: straight, at: 1 }])).toEqual([]);
    expect(decideGuidanceAnnouncement(INITIAL_GUIDANCE_MEMORY, null, 1, 'x').text).toBeNull();
  });
});

describe('the words', () => {
  it("describes the passenger's trip as plain sentences, as the brief asks", () => {
    const lines = describeTripProgress({
      placeName: 'Kalimati, Kathmandu',
      destinationName: 'the destination',
      distanceRemainingMeters: 180,
      etaSeconds: 11 * 60,
      basis: 'route',
    });
    expect(lines).toEqual([
      'You are travelling toward your destination.',
      'Current location: Kalimati, Kathmandu.',
      'Distance remaining: 180 meters.',
      'Estimated arrival: 11 minutes.',
      'You are approximately 180 meters from the destination.',
    ]);
    const far = describeTripProgress({
      placeName: null,
      destinationName: 'Patan Durbar Square',
      distanceRemainingMeters: 3400,
      etaSeconds: 660,
      basis: 'estimate',
    });
    expect(far).toContain('Distance remaining: 3.4 kilometres.');
    expect(far).toContain('Estimated arrival: 11 minutes (estimate).');
    expect(far.some((l) => l.startsWith('Current location'))).toBe(false); // never invents a place
  });

  it("describes the driver's state in the order they need it", () => {
    expect(nextStepSentence(guidance())).toBe('In 900 meters, turn left onto New Road.');
    expect(nextStepSentence(guidance({ next: null }))).toBeNull();
    const text = describeGuidance(guidance(), 'Thamel');
    expect(text).toContain('In 900 meters, turn left onto New Road.');
    expect(text).toContain('2.4 kilometres to Thamel');
    expect(text).toContain('about 7 minutes');
    const off = describeGuidance(guidance({ offRoute: true }), 'Thamel');
    expect(off.startsWith('You are off the planned route.')).toBe(true);
    expect(off).not.toContain('turn left');
    expect(describeGuidance(guidance({ basis: 'estimate' }), 'Thamel')).toContain('(estimate)');
  });
});
