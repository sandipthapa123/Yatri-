import type { LiveParty, LiveTripSnapshot, WaitingInfo } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import {
  decideAnnouncement,
  distanceStep,
  INITIAL_ANNOUNCE_STATE,
  POLITE_MIN_INTERVAL_MS,
  type AnnounceState,
} from './announcementPolicy';
import {
  ageText,
  distancePhrase,
  etaPhrase,
  formatDuration,
  freshnessPhrase,
  liveSentence,
  placePhrase,
  summaryRows,
} from './tripText';

const driverWaiting = (seconds: number): WaitingInfo => ({
  driver: { startedAt: '2026-01-01T00:00:00.000Z', seconds, notifiedAt: null },
  passenger: null,
  rule: { freeSeconds: 180, perMinuteNpr: 5, noShowAfterSeconds: 600 },
  affectsFare: seconds > 180,
  chargeableSeconds: Math.max(0, seconds - 180),
  chargeNpr: 0,
});

const party = (over: Partial<LiveParty> = {}): LiveParty => ({
  latitude: 27.7,
  longitude: 85.3,
  accuracyMeters: 15,
  headingDegrees: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ageSeconds: 2,
  freshness: 'live',
  placeName: 'New Road',
  placeKind: 'road',
  placeStale: false,
  ...over,
});

function snapshot(over: Partial<LiveTripSnapshot> = {}): LiveTripSnapshot {
  return {
    tripId: 't1',
    status: 'DRIVER_EN_ROUTE',
    version: 1,
    lastEventSeq: 0,
    serverTime: '2026-01-01T00:00:00.000Z',
    pickup: {
      name: 'Kathmandu Mall',
      address: 'Sundhara, Kathmandu',
      latitude: 27.7,
      longitude: 85.3,
    },
    destination: { name: 'Thamel', address: 'Kathmandu', latitude: 27.71, longitude: 85.31 },
    driver: party(),
    passenger: null,
    driverArrival: { distanceMeters: 180, etaSeconds: 120, basis: 'estimate' },
    trip: null,
    waiting: null,
    navigation: null,
    ...over,
  };
}
const at = (meters: number, eta: number | null = 60, driver: Partial<LiveParty> = {}) =>
  snapshot({
    driverArrival: { distanceMeters: meters, etaSeconds: eta, basis: 'route' },
    driver: party(driver),
  });

describe('spoken phrases', () => {
  it.each([
    [10, 'Driver is very close.'],
    [50, 'Driver is 50 meters away.'],
    [85, 'Driver is 85 meters away.'],
    [100, 'Driver is 100 meters away.'],
    [240, 'Driver is 240 meters away.'],
    [500, 'Driver is 500 meters away.'],
    [1000, 'Driver is 1 kilometre away.'],
    [5000, 'Driver is 5 kilometres away.'],
  ])('%s m -> "%s"', (m, text) => expect(distancePhrase('Driver', m)).toBe(text));

  it('formats durations in words', () => {
    expect(formatDuration(45)).toBe('45 seconds');
    expect(formatDuration(3)).toBe('5 seconds');
    expect(formatDuration(58)).toBe('1 minute');
    expect(formatDuration(60)).toBe('1 minute');
    expect(formatDuration(180)).toBe('3 minutes');
    expect(formatDuration(3900)).toBe('1 hour 5 minutes');
    expect(formatDuration(-1)).toBe('unknown time');
    expect(etaPhrase('arrival', 180)).toBe('Estimated arrival in 3 minutes.');
    expect(etaPhrase('arrival', 45)).toBe('Estimated arrival in 45 seconds.');
    expect(etaPhrase('arrival', null)).toBeNull();
  });

  it('says "on" for roads and "near" for places', () => {
    expect(placePhrase('Driver', 'New Road', 'road')).toBe('Driver is on New Road.');
    expect(placePhrase('Passenger', 'Kathmandu Durbar Square', 'place')).toBe(
      'Passenger is near Kathmandu Durbar Square.',
    );
    expect(placePhrase('You', 'Thamel', 'place', 'are')).toBe('You are near Thamel.');
    expect(placePhrase('Driver', null, null)).toBeNull();
  });

  it('describes staleness and signal loss', () => {
    expect(ageText(2)).toBe('just now');
    expect(ageText(42)).toBe('40 seconds ago');
    expect(freshnessPhrase('Driver', 'stale', 40)).toContain('may be delayed');
    expect(freshnessPhrase('Driver', 'lost', 120)).toBe(
      'Driver location signal lost. Last seen 2 minutes ago.',
    );
    expect(freshnessPhrase('Driver', 'none', 0)).toContain('not available yet');
  });

  it('builds the live sentence a blind rider needs', () => {
    expect(liveSentence(snapshot(), 'PASSENGER')).toBe(
      'Driver is 180 meters away. Estimated arrival in 2 minutes. Driver is on New Road.',
    );
  });
});

describe('summary rows (the non-visual trip layer)', () => {
  const rows = (s: LiveTripSnapshot, v: 'PASSENGER' | 'DRIVER' = 'PASSENGER') =>
    Object.fromEntries(summaryRows(s, v).map((r) => [r.label, r.value]));

  it('lists location, distance, ETA, status, pickup and destination as text', () => {
    const r = rows(snapshot());
    expect(r['Driver’s current location']).toBe('New Road');
    expect(r['Driver distance']).toBe('180 meters');
    expect(r['Driver arrival ETA']).toBe('2 minutes (estimate)');
    expect(r['Trip status']).toBe('Driver is on the way');
    expect(r['Pickup']).toBe('Kathmandu Mall, Sundhara, Kathmandu');
    expect(r['Destination']).toBe('Thamel, Kathmandu');
    expect(r['Location accuracy']).toBe('approximately 15 meters');
    expect(r['Last location update']).toBe('just now');
  });

  it('never presents trip ETA as driver arrival ETA (and vice versa)', () => {
    const enRoute = rows(snapshot());
    expect(enRoute['Trip ETA']).toBeUndefined();
    expect(enRoute['Waiting time']).toBeUndefined();

    const riding = rows(
      snapshot({
        status: 'IN_PROGRESS',
        driverArrival: null,
        trip: {
          distanceRemainingMeters: 4200,
          etaSeconds: 900,
          progressPercent: null,
          basis: 'route',
        },
      }),
    );
    expect(riding['Trip ETA']).toBe('15 minutes');
    expect(riding['Driver arrival ETA']).toBeUndefined();
    expect(riding['Distance to destination']).toBe('4.2 kilometres');

    const waiting = rows(
      snapshot({ status: 'DRIVER_ARRIVED', driverArrival: null, waiting: driverWaiting(130) }),
    );
    expect(waiting['Your driver has been waiting']).toBe(
      '2 minutes 10 seconds. Free waiting time remaining: 50 seconds.',
    );
    expect(waiting['Driver arrival ETA']).toBeUndefined();
    expect(waiting['Trip ETA']).toBeUndefined();
  });

  it('is honest about missing data and lost signal', () => {
    expect(rows(snapshot({ driver: null, driverArrival: null }))['Driver’s current location']).toBe(
      'Not available yet',
    );
    expect(
      rows(snapshot({ driver: party({ placeName: null, placeStale: true }) }))[
        'Driver’s current location'
      ],
    ).toBe('Place name temporarily unavailable');
    expect(
      rows(snapshot({ driver: party({ freshness: 'lost', ageSeconds: 90 }) }))[
        'Last location update'
      ],
    ).toBe('2 minutes ago (signal lost)');
  });

  it('gives the driver a driver-appropriate view', () => {
    const r = rows(snapshot(), 'DRIVER');
    expect(r['Distance to pickup']).toBe('180 meters');
    expect(r['Your current location']).toBe('New Road');
  });
});

describe('announcement policy: informed, not flooded', () => {
  const run = (
    snaps: Array<[number, LiveTripSnapshot]>,
    viewer: 'PASSENGER' | 'DRIVER' = 'PASSENGER',
  ) => {
    let state: AnnounceState = INITIAL_ANNOUNCE_STATE;
    const spoken: Array<{ t: number; polite?: string; assertive?: string }> = [];
    for (const [t, s] of snaps) {
      const r = decideAnnouncement(state, s, t, viewer);
      state = r.next;
      if (r.announcement.polite || r.announcement.assertive) spoken.push({ t, ...r.announcement });
    }
    return spoken;
  };

  it('speaks once at first contact, with the full picture', () => {
    const [first] = run([[0, snapshot()]]);
    expect(first?.polite).toBe(
      'Driver is 180 meters away. Estimated arrival in 2 minutes. Driver is on New Road.',
    );
  });

  it('stays silent for GPS jitter of a few metres', () => {
    const jitter = Array.from({ length: 40 }, (_, i): [number, LiveTripSnapshot] => [
      i * 2000,
      at(500 + ((i % 5) - 2) * 6, 200), // ±12 m wobble
    ]);
    expect(run(jitter)).toHaveLength(1); // only the initial message
  });

  it('announces a real approach in steps, not on every fix', () => {
    const approach: Array<[number, LiveTripSnapshot]> = [];
    let t = 0;
    for (let d = 1000; d >= 10; d -= 10) {
      approach.push([t, at(d, Math.round(d / 6))]);
      t += 2000; // a fix every 2 s
    }
    const spoken = run(approach);
    expect(approach.length).toBeGreaterThan(90);
    expect(spoken.length).toBeGreaterThan(3);
    expect(spoken.length).toBeLessThan(15); // ~100 fixes -> a handful of messages
    for (let i = 1; i < spoken.length; i++) {
      expect(spoken[i]!.t - spoken[i - 1]!.t).toBeGreaterThanOrEqual(POLITE_MIN_INTERVAL_MS);
    }
    expect(spoken.at(-1)?.polite).toMatch(/very close|\d+ meters away/);
  });

  it('respects the distance step sizes', () => {
    expect(distanceStep(120)).toBe(50);
    expect(distanceStep(600)).toBe(100);
    expect(distanceStep(3000)).toBe(500);
  });

  it('rate limits ordinary updates; phase changes are never spoken from snapshots', () => {
    const spoken = run([
      [0, at(1000, 300)],
      [2000, at(700, 200)], // big change but < 10 s since last -> held back
      [4000, at(400, 100)],
      [
        5000,
        snapshot({ status: 'DRIVER_ARRIVED', driverArrival: null, waiting: driverWaiting(0) }),
      ],
    ]);
    // "Your driver has arrived" comes from the DRIVER_ARRIVED event (see liveTripController.test),
    // so the snapshot pipeline stays silent here instead of reading it twice.
    expect(spoken.map((s) => s.t)).toEqual([0]);
    expect(spoken.every((s) => s.assertive === undefined)).toBe(true);
  });

  it('announces a place-name change once, and not while it is unchanged', () => {
    const spoken = run([
      [0, at(900, 200)],
      [12_000, at(880, 195, { placeName: 'Kanti Path', placeKind: 'road' })],
      [24_000, at(870, 190, { placeName: 'Kanti Path', placeKind: 'road' })],
      [36_000, at(860, 185, { placeName: 'Kanti Path', placeKind: 'road' })],
    ]);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]?.polite).toBe('Driver is on Kanti Path.');
  });

  it('says so, once, when the place name becomes unavailable', () => {
    const spoken = run([
      [0, at(900, 200)],
      [12_000, at(900, 200, { placeStale: true })],
      [24_000, at(900, 200, { placeStale: true })],
    ]);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]?.polite).toBe('Place name temporarily unavailable.');
  });

  it('never speaks phase changes or signal loss itself — those are server events', () => {
    const base = snapshot();
    const first = decideAnnouncement(INITIAL_ANNOUNCE_STATE, base, 0, 'PASSENGER').next;
    for (const next of [
      snapshot({ status: 'DRIVER_ARRIVED', driverArrival: null, waiting: driverWaiting(0) }),
      snapshot({ status: 'IN_PROGRESS', driverArrival: null }),
      snapshot({ status: 'COMPLETED', driver: null, driverArrival: null }),
      snapshot({ status: 'CANCELLED', driver: null, driverArrival: null }),
      snapshot({ driver: party({ freshness: 'lost', ageSeconds: 90 }) }),
    ]) {
      const r = decideAnnouncement(first, next, 1000, 'PASSENGER').announcement;
      expect(r.assertive).toBeUndefined();
    }
  });

  it('does not repeat itself when the same snapshot arrives twice (duplicate events)', () => {
    const s = at(400, 100);
    expect(
      run([
        [0, s],
        [15_000, s],
        [30_000, s],
      ]),
    ).toHaveLength(1);
  });

  it('never announces trip ETA using the arrival wording', () => {
    const spoken = run([
      [
        0,
        snapshot({
          status: 'IN_PROGRESS',
          driverArrival: null,
          trip: {
            distanceRemainingMeters: 4200,
            etaSeconds: 900,
            progressPercent: null,
            basis: 'route',
          },
        }),
      ],
    ]);
    expect(spoken[0]?.polite).toContain('Estimated time to destination');
    expect(spoken[0]?.polite).not.toContain('Estimated arrival');
  });
});

describe('waiting rows: who has been told', () => {
  const rows = (snap: LiveTripSnapshot) =>
    Object.fromEntries(summaryRows(snap, 'DRIVER').map((r) => [r.label, r.value]));
  const waiting = (notifiedAt: string | null) => ({
    ...driverWaiting(60),
    driver: { startedAt: '2026-01-01T00:00:00.000Z', seconds: 60, notifiedAt },
  });
  it('tells the driver the passenger has been notified once the server has stamped it', () => {
    const told = rows(
      snapshot({
        status: 'DRIVER_ARRIVED',
        driverArrival: null,
        waiting: waiting('2026-01-01T00:00:01.000Z'),
      }),
    );
    expect(told['You have been waiting']).toContain('The passenger has been notified.');
    const notYet = rows(
      snapshot({ status: 'DRIVER_ARRIVED', driverArrival: null, waiting: waiting(null) }),
    );
    expect(notYet['You have been waiting']).not.toContain('notified');
  });
  it('does not say it to the passenger, who is the one being told', () => {
    const forPassenger = summaryRows(
      snapshot({
        status: 'DRIVER_ARRIVED',
        driverArrival: null,
        waiting: waiting('2026-01-01T00:00:01.000Z'),
      }),
      'PASSENGER',
    );
    const row = forPassenger.find((r) => r.label === 'Your driver has been waiting');
    expect(row?.value).not.toContain('notified');
  });
});

describe('announcement policy: the search', () => {
  it('says "Searching for a driver." once when the screen opens on a search, and nothing more from snapshots', () => {
    const searching = snapshot({
      status: 'SEARCHING',
      driver: null,
      driverArrival: null,
      trip: null,
    });
    const first = decideAnnouncement(INITIAL_ANNOUNCE_STATE, searching, 0, 'PASSENGER');
    expect(first.announcement.polite).toBe('Searching for a driver.');
    const again = decideAnnouncement(first.next, { ...searching, version: 2 }, 15_000, 'PASSENGER');
    expect(again.announcement).toEqual({});
    // the steps of the search are spoken from events (driver found, declined, accepted), not here
  });
});
