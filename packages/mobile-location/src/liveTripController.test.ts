import type {
  LiveParty,
  LiveTripSnapshot,
  TripEventRecord,
  TripEventType,
  WaitingInfo,
} from '@yatri/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveTripController } from './liveTripController';
import type { WebSocketLike } from './realtimeClient';

class Sock implements WebSocketLike {
  readyState = 1;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  push(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

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
  accuracyMeters: 10,
  headingDegrees: null,
  updatedAt: '',
  ageSeconds: 1,
  freshness: 'live',
  placeName: 'New Road',
  placeKind: 'road',
  placeStale: false,
  ...over,
});
const ev = (
  seq: number,
  type: TripEventType,
  payload: Record<string, unknown> = {},
): TripEventRecord => ({ tripId: 't', seq, type, payload, createdAt: '' });
const snap = (
  version: number,
  meters: number,
  over: Partial<LiveTripSnapshot> = {},
): LiveTripSnapshot => ({
  tripId: 't',
  status: 'DRIVER_EN_ROUTE',
  version,
  lastEventSeq: 0,
  serverTime: '',
  pickup: { name: 'p', address: '', latitude: 1, longitude: 1 },
  destination: { name: 'd', address: '', latitude: 1, longitude: 1 },
  driver: party(),
  passenger: null,
  driverArrival: { distanceMeters: meters, etaSeconds: meters / 5, basis: 'estimate' },
  trip: null,
  waiting: null,
  ...over,
});

let sock: Sock;
let clock: number;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
});
afterEach(() => vi.useRealTimers());

function make(extra: Partial<ConstructorParameters<typeof LiveTripController>[0]> = {}) {
  const c = new LiveTripController({
    ...extra,
    tripId: 't',
    viewer: 'PASSENGER',
    getToken: async () => 'tok',
    url: 'ws://x',
    now: () => clock,
    createSocket: () => (sock = new Sock()),
  });
  c.start();
  return c;
}

describe('LiveTripController', () => {
  it('turns pushed snapshots into state and a single polite announcement, without any refresh', () => {
    const c = make();
    const seen: number[] = [];
    c.subscribe(() => seen.push(c.getState().snapshot?.version ?? -1));

    sock.push({ type: 'snapshot', snapshot: snap(1, 400) });
    expect(c.getState().polite?.text).toBe(
      'Driver is 400 meters away. Estimated arrival in 1 minute. Driver is on New Road.',
    );
    clock += 2000;
    sock.push({ type: 'snapshot', snapshot: snap(2, 396) }); // jitter: state updates, speech does not
    expect(c.getState().snapshot?.version).toBe(2);
    expect(c.getState().polite?.id).toBe(1);
    expect(seen).toEqual([1, 2]);
    c.stop();
  });

  it('ignores an older snapshot arriving late', () => {
    const c = make();
    sock.push({ type: 'snapshot', snapshot: snap(5, 300) });
    sock.push({ type: 'snapshot', snapshot: snap(4, 900) });
    expect(c.getState().snapshot?.driverArrival?.distanceMeters).toBe(300);
    c.stop();
  });

  it('does not speak phase changes from snapshots — the event does, once', () => {
    const c = make();
    sock.push({ type: 'snapshot', snapshot: snap(1, 40) });
    clock += 1000;
    sock.push({
      type: 'snapshot',
      snapshot: snap(2, 0, {
        status: 'DRIVER_ARRIVED',
        driverArrival: null,
        waiting: driverWaiting(0),
      }),
    });
    expect(c.getState().assertive).toBeNull();
    sock.push({ type: 'trip_event', event: ev(1, 'DRIVER_ARRIVED'), important: true });
    expect(c.getState().assertive?.text).toBe('Your driver has arrived.');
    const id = c.getState().assertive?.id;
    sock.push({ type: 'trip_event', event: ev(1, 'DRIVER_ARRIVED'), important: true }); // duplicate
    expect(c.getState().assertive?.id).toBe(id);
    expect(c.getState().events.map((e) => e.seq)).toEqual([1]);
    c.stop();
  });

  it('speaks waiting milestones politely in the exact server wording, and skips DRIVER_NEARBY', () => {
    const c = make();
    sock.push({
      type: 'trip_event',
      event: ev(1, 'DRIVER_NEARBY', { distanceMeters: 900 }),
      important: false,
    });
    expect(c.getState().polite).toBeNull(); // distance changes are spoken from snapshots
    sock.push({
      type: 'trip_event',
      event: ev(2, 'DRIVER_WAITING', { seconds: 120 }),
      important: false,
    });
    expect(c.getState().polite?.text).toBe('Your driver has been waiting for 2 minutes.');
    expect(c.getState().assertive).toBeNull();
    sock.push({ type: 'trip_event', event: ev(3, 'TRIP_STARTED'), important: true });
    expect(c.getState().assertive?.text).toBe('Your ride has started.');
    c.stop();
  });

  it('records history silently, and catches up (aloud) after a gap or a reconnect', async () => {
    const all = [ev(1, 'TRIP_REQUESTED'), ev(2, 'DRIVER_ASSIGNED')];
    const fetchEvents = vi.fn(async (after: number) => all.filter((e) => e.seq > after));
    const c = make({ fetchEvents });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().events.map((e) => e.seq)).toEqual([1, 2]);
    expect(c.getState().polite).toBeNull();
    expect(c.getState().assertive).toBeNull(); // opening the screen does not replay the past

    // seq 4 arrives but 3 was missed: fetch instead of applying out of order
    all.push(ev(3, 'DRIVER_ARRIVED'), ev(4, 'DRIVER_WAITING', { seconds: 60 }));
    sock.push({ type: 'trip_event', event: all[3]!, important: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(c.getState().assertive?.text).toBe('Your driver has arrived.'); // the important one leads
    c.stop();
  });

  it('tells the user when live updates drop and come back', () => {
    const c = make();
    sock.push({ type: 'authed', userId: 'u', role: 'PASSENGER' });
    sock.push({ type: 'subscribed', tripId: 't' });
    expect(c.getState().connection).toBe('live');
    sock.close();
    expect(c.getState().connection).toBe('reconnecting');
    expect(c.getState().connectionNotice).toBe('Live updates interrupted. Reconnecting.');
    vi.advanceTimersByTime(1000);
    sock.push({ type: 'authed', userId: 'u', role: 'PASSENGER' });
    sock.push({ type: 'subscribed', tripId: 't' });
    expect(c.getState().connectionNotice).toBe('Live updates restored.');
    c.stop();
  });
});
