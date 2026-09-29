import type { LiveParty, LiveTripSnapshot } from '@yatri/types';
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

const party = (over: Partial<LiveParty> = {}): LiveParty => ({
  latitude: 27.7,
  longitude: 85.3,
  accuracyMeters: 10,
  updatedAt: '',
  ageSeconds: 1,
  freshness: 'live',
  placeName: 'New Road',
  placeKind: 'road',
  placeStale: false,
  ...over,
});
const snap = (
  eventId: number,
  meters: number,
  over: Partial<LiveTripSnapshot> = {},
): LiveTripSnapshot => ({
  tripId: 't',
  status: 'DRIVER_EN_ROUTE',
  eventId,
  serverTime: '',
  pickup: { name: 'p', address: '', latitude: 1, longitude: 1 },
  destination: { name: 'd', address: '', latitude: 1, longitude: 1 },
  driver: party(),
  passenger: null,
  driverArrival: { distanceMeters: meters, etaSeconds: meters / 5, basis: 'estimate' },
  trip: null,
  waitingSeconds: null,
  ...over,
});

let sock: Sock;
let clock: number;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
});
afterEach(() => vi.useRealTimers());

function make() {
  const c = new LiveTripController({
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
    c.subscribe(() => seen.push(c.getState().snapshot?.eventId ?? -1));

    sock.push({ type: 'snapshot', snapshot: snap(1, 400) });
    expect(c.getState().polite?.text).toBe(
      'Driver is 400 meters away. Estimated arrival in 1 minute. Driver is on New Road.',
    );
    clock += 2000;
    sock.push({ type: 'snapshot', snapshot: snap(2, 396) }); // jitter: state updates, speech does not
    expect(c.getState().snapshot?.eventId).toBe(2);
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

  it('speaks arrival assertively and only once', () => {
    const c = make();
    sock.push({ type: 'snapshot', snapshot: snap(1, 40) });
    clock += 1000;
    const arrived = snap(2, 0, {
      status: 'DRIVER_ARRIVED',
      driverArrival: null,
      waitingSeconds: 0,
    });
    sock.push({ type: 'snapshot', snapshot: arrived });
    const first = c.getState().assertive;
    expect(first?.text).toBe('Your driver has arrived at the pickup.');
    clock += 1000;
    sock.push({ type: 'snapshot', snapshot: { ...arrived, eventId: 3 } });
    expect(c.getState().assertive?.id).toBe(first?.id);
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
