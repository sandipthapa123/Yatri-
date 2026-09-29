import type { LiveTripSnapshot } from '@yatri/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  realtimeUrlFrom,
  TripRealtimeClient,
  type ConnectionState,
  type WebSocketLike,
} from './realtimeClient';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | undefined;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  // test controls
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

const snap = (version: number, extra: Partial<LiveTripSnapshot> = {}): LiveTripSnapshot => ({
  tripId: 't',
  status: 'DRIVER_EN_ROUTE',
  version,
  lastEventSeq: 0,
  serverTime: '',
  pickup: { name: 'p', address: '', latitude: 1, longitude: 1 },
  destination: { name: 'd', address: '', latitude: 1, longitude: 1 },
  driver: null,
  passenger: null,
  driverArrival: null,
  trip: null,
  waiting: null,
  ...extra,
});

let sockets: FakeSocket[];
let states: ConnectionState[];
let snaps: LiveTripSnapshot[];
let rejected: string[];
let clock: number;
let token = 'tok-1';

function make(over: Partial<ConstructorParameters<typeof TripRealtimeClient>[0]> = {}) {
  return new TripRealtimeClient({
    url: 'ws://x/ws/v1/realtime',
    tripId: 't',
    getToken: async () => token,
    onSnapshot: (s) => snaps.push(s),
    onConnection: (s) => states.push(s),
    onRejected: (r) => rejected.push(r),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => clock,
    random: () => 1,
    ...over,
  });
}
const last = () => sockets[sockets.length - 1]!;
async function connectFully(c: TripRealtimeClient) {
  c.start();
  last().open();
  await vi.advanceTimersByTimeAsync(0);
  last().receive({ type: 'authed', userId: 'u', role: 'PASSENGER' });
  last().receive({ type: 'subscribed', tripId: 't' });
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  states = [];
  snaps = [];
  rejected = [];
  clock = 1_000_000;
  token = 'tok-1';
});
afterEach(() => vi.useRealTimers());

describe('TripRealtimeClient', () => {
  it('authenticates over the socket (not the URL), then subscribes', async () => {
    const c = make();
    c.start();
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().sent[0]).toEqual({ type: 'auth', token: 'tok-1' });
    expect(sockets[0]).toBeDefined();
    last().receive({ type: 'authed', userId: 'u', role: 'PASSENGER' });
    expect(last().sent[1]).toEqual({ type: 'subscribe', tripId: 't' });
    last().receive({ type: 'subscribed', tripId: 't' });
    expect(states).toEqual(['live']); // initial state is 'connecting'
    c.stop();
  });

  it('applies snapshots in order and ignores stale / out-of-order ones', async () => {
    const c = make();
    await connectFully(c);
    last().receive({ type: 'snapshot', snapshot: snap(5) });
    last().receive({ type: 'snapshot', snapshot: snap(7) });
    last().receive({ type: 'snapshot', snapshot: snap(6) }); // late
    last().receive({ type: 'snapshot', snapshot: snap(7) }); // same-id re-issue allowed
    expect(snaps.map((s) => s.version)).toEqual([5, 7, 7]);
    c.stop();
  });

  it('reconnects with exponential, capped backoff and resubscribes to get full state', async () => {
    const c = make({ baseDelayMs: 1000, maxDelayMs: 8000 });
    await connectFully(c);
    last().drop();
    expect(states.at(-1)).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2); // 1st retry after 1 s
    last().drop(); // fails before ever connecting
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(3); // 2nd after 2 s
    last().drop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(sockets).toHaveLength(4);
    last().drop();
    await vi.advanceTimersByTimeAsync(8000);
    expect(sockets).toHaveLength(5);
    last().drop();
    await vi.advanceTimersByTimeAsync(8000); // capped at 8 s, not 16
    expect(sockets).toHaveLength(6);

    // Once connected again: authenticates, resubscribes, backoff resets.
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    last().receive({ type: 'authed', userId: 'u', role: 'PASSENGER' });
    expect(last().sent.at(-1)).toEqual({ type: 'subscribe', tripId: 't' });
    last().receive({ type: 'subscribed', tripId: 't' });
    expect(states.at(-1)).toBe('live');
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(7);
    c.stop();
  });

  it('a reconnect accepts the fresh snapshot even though it is "older" than nothing seen', async () => {
    const c = make({ baseDelayMs: 10 });
    await connectFully(c);
    last().receive({ type: 'snapshot', snapshot: snap(9) });
    last().drop();
    await vi.advanceTimersByTimeAsync(20);
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    last().receive({ type: 'authed', userId: 'u', role: 'PASSENGER' });
    last().receive({ type: 'subscribed', tripId: 't' });
    last().receive({ type: 'snapshot', snapshot: snap(12, { status: 'DRIVER_ARRIVED' }) });
    expect(snaps.at(-1)?.status).toBe('DRIVER_ARRIVED');
    c.stop();
  });

  it('stops for good when the trip is gone (NOT_FOUND) instead of reconnecting forever', async () => {
    const c = make({ baseDelayMs: 10 });
    c.start();
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    last().receive({ type: 'authed', userId: 'u', role: 'PASSENGER' });
    last().receive({ type: 'error', code: 'NOT_FOUND', message: 'Trip not available.' });
    expect(states.at(-1)).toBe('ended');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('stops (no retry storm) when a token cannot be obtained', async () => {
    const c = make({
      getToken: async () => {
        throw new Error('signed out');
      },
    });
    c.start();
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe('closed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('re-sends auth with a fresh token before the old one expires', async () => {
    const c = make();
    await connectFully(c);
    token = 'tok-2';
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(
      last()
        .sent.filter((m) => m.type === 'auth')
        .map((m) => m.token),
    ).toEqual(['tok-1', 'tok-2']);
    c.stop();
  });

  it('detects a half-open connection (silence) and reconnects', async () => {
    const c = make({ baseDelayMs: 10 });
    await connectFully(c);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(last().sent.some((m) => m.type === 'ping')).toBe(true);
    clock += 60_000; // nothing heard for a minute
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets[0]!.closedWith).toBe(4000);
    await vi.advanceTimersByTimeAsync(20);
    expect(sockets).toHaveLength(2);
    c.stop();
  });

  it('keeps only the LATEST location while offline and drops it once too old', async () => {
    const c = make({ baseDelayMs: 10 });
    c.start();
    // Not connected yet: three samples queue, only the newest survives.
    for (const lat of [27.1, 27.2, 27.3]) {
      c.sendLocation('passenger_location', {
        latitude: lat,
        longitude: 85,
        accuracyMeters: 5,
        deviceTimeMs: clock,
      });
    }
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    last().receive({ type: 'authed', userId: 'u', role: 'DRIVER' });
    last().receive({ type: 'subscribed', tripId: 't' });
    const sent = last().sent.filter((m) => m.type === 'passenger_location');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ latitude: 27.3, tripId: 't' });

    // A sample that sat in the queue for over 25 s is discarded instead of being sent late.
    last().drop();
    c.sendLocation('passenger_location', {
      latitude: 27.4,
      longitude: 85,
      accuracyMeters: 5,
      deviceTimeMs: clock,
    });
    clock += 40_000;
    await vi.advanceTimersByTimeAsync(20);
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    last().receive({ type: 'authed', userId: 'u', role: 'DRIVER' });
    last().receive({ type: 'subscribed', tripId: 't' });
    expect(last().sent.filter((m) => m.type === 'passenger_location')).toHaveLength(0);
    c.stop();
  });

  it('throttles outgoing locations to one per second', async () => {
    const c = make();
    await connectFully(c);
    const sample = (lat: number) => ({
      latitude: lat,
      longitude: 85,
      accuracyMeters: 5,
      deviceTimeMs: clock,
    });
    c.sendLocation('passenger_location', sample(27.1));
    c.sendLocation('passenger_location', sample(27.2)); // within 1 s: held, superseded
    clock += 1100;
    c.sendLocation('passenger_location', sample(27.3));
    expect(
      last()
        .sent.filter((m) => m.type === 'passenger_location')
        .map((m) => m.latitude),
    ).toEqual([27.1, 27.3]);
    c.stop();
  });

  it('surfaces server rejections without breaking the connection', async () => {
    const c = make();
    await connectFully(c);
    last().receive({ type: 'rejected', tripId: 't', reason: 'impossible_jump' });
    expect(rejected).toEqual(['impossible_jump']);
    expect(states.at(-1)).toBe('live');
    c.stop();
  });

  it('stop() cancels every timer and closes cleanly', async () => {
    const c = make();
    await connectFully(c);
    c.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('realtimeUrlFrom', () => {
  it('derives ws(s) from the REST base and honours an override', () => {
    expect(realtimeUrlFrom('http://localhost:4000/api/v1')).toBe(
      'ws://localhost:4000/ws/v1/realtime',
    );
    expect(realtimeUrlFrom('https://api.yatri.app/api/v1')).toBe(
      'wss://api.yatri.app/ws/v1/realtime',
    );
    expect(realtimeUrlFrom('http://x/api/v1', 'wss://custom/ws')).toBe('wss://custom/ws');
  });
});
