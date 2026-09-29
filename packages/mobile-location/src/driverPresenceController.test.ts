import type { DriverAvailabilityStatus, ServerRealtimeMessage } from '@yatri/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DriverPresenceController,
  type GpsFix,
  type LocationAdapter,
  type PresenceApi,
  type PresenceClient,
} from './driverPresenceController';
import { describePresence, LOCATION_STATUS_TEXT, locationStatusKey } from './driverPresenceText';
import type { ConnectionState, PresenceSample } from './realtimeClient';

let clock = 1_000_000;
const status = (over: Partial<DriverAvailabilityStatus> = {}): DriverAvailabilityStatus => ({
  state: 'ONLINE',
  reason: null,
  onlineSince: null,
  locationFreshness: 'fresh',
  lastLocationAt: null,
  lastLocationAgeSeconds: 0,
  accuracyMeters: 8,
  eligibility: { eligible: true, reasons: [] },
  updateIntervalsMs: { idle: 10_000, enRoute: 3000, onTrip: 3000 },
  freshWithinSeconds: 30,
  onlineMaxAccuracyMeters: 100,
  ...over,
});
const gps = (over: Partial<GpsFix> = {}): GpsFix => ({
  latitude: 27.7154,
  longitude: 85.3123,
  accuracyMeters: 8,
  timestampMs: clock,
  ...over,
});

class FakeClient implements PresenceClient {
  started = false;
  stopped = false;
  sent: PresenceSample[] = [];
  handlers!: {
    onConnection: (s: ConnectionState) => void;
    onMessage: (m: ServerRealtimeMessage) => void;
  };
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  sendPresenceLocation(s: PresenceSample) {
    this.sent.push(s);
  }
}

function setup(
  over: {
    permission?: 'granted' | 'denied' | 'blocked';
    services?: boolean;
    fixes?: Array<GpsFix | Error>;
    onlineImpl?: PresenceApi['online'];
    offlineImpl?: PresenceApi['offline'];
    statusImpl?: PresenceApi['status'];
  } = {},
) {
  const client = new FakeClient();
  let onFix: ((f: GpsFix) => void) | null = null;
  const removed = vi.fn();
  const fixes = [...(over.fixes ?? [gps()])];
  const location: LocationAdapter = {
    ensurePermission: async () => over.permission ?? 'granted',
    servicesEnabled: async () => over.services ?? true,
    getCurrent: async () => {
      const next = fixes.length > 1 ? fixes.shift()! : fixes[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    watch: async (_o, cb) => {
      onFix = cb;
      return { remove: removed };
    },
  };
  const api: PresenceApi = {
    online: over.onlineImpl ?? (async () => status()),
    offline: over.offlineImpl ?? (async () => status({ state: 'OFFLINE' })),
    status: over.statusImpl ?? (async () => status({ state: 'OFFLINE' })),
  };
  const c = new DriverPresenceController({
    location,
    api,
    now: () => clock,
    acquireRetryMs: 0,
    createClient: (h) => {
      client.handlers = h;
      return client;
    },
    reverseGeocode: async () => 'Thamel, Kathmandu',
  });
  return { c, client, removed, pushFix: (f: GpsFix) => onFix?.(f), api };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
});
afterEach(() => vi.useRealTimers());

describe('going online', () => {
  it('checks permission, gets an accurate fix, asks the server, then starts sharing and announces it', async () => {
    const { c, client, pushFix } = setup();
    const p = c.goOnline();
    expect(c.getState().phase).toBe('going-online');
    await p;
    await flush();

    const s = c.getState();
    expect(s.phase).toBe('online');
    expect(s.permission).toBe('granted');
    expect(client.started).toBe(true);
    expect(s.announcement).toEqual({
      id: expect.any(Number),
      text: 'You are now online. Your location is being shared with Yatri.',
      assertive: true,
    });
    expect(c.getState().placeName).toBe('Thamel, Kathmandu');

    clock += 10_000;
    pushFix(gps({ timestampMs: clock, accuracyMeters: 6, headingDegrees: 30, speedMps: 4 }));
    expect(client.sent.at(-1)).toMatchObject({
      accuracyMeters: 6,
      headingDegrees: 30,
      speedMps: 4,
    });
    c.dispose();
  });

  it('uses the update interval the server configured', async () => {
    const { c } = setup({
      onlineImpl: async () =>
        status({ updateIntervalsMs: { idle: 15_000, enRoute: 3000, onTrip: 3000 } }),
    });
    await c.goOnline();
    expect(c.getState().intervalMs).toBe(15_000);
    c.dispose();
  });

  it.each([
    ['denied', /allow location/i],
    ['blocked', /open your phone settings/i],
  ] as const)(
    'stays offline when permission is %s, with a clear reason',
    async (permission, text) => {
      const { c, client } = setup({ permission });
      await c.goOnline();
      expect(c.getState().phase).toBe('offline');
      expect(c.getState().permission).toBe(permission);
      expect(c.getState().problem?.message).toMatch(text);
      expect(client.started).toBe(false);
      expect(locationStatusKey(c.getState())).toBe('permission-required');
      expect(c.getState().announcement?.text).toContain('still offline');
    },
  );

  it('stays offline when the phone location service is off', async () => {
    const { c } = setup({ services: false });
    await c.goOnline();
    expect(c.getState()).toMatchObject({ phase: 'offline', gps: 'unavailable' });
    expect(c.getState().problem?.code).toBe('SERVICES_OFF');
  });

  it('refuses a weak GPS fix and stays offline (never asks the server)', async () => {
    const online = vi.fn(async () => status());
    const { c } = setup({ fixes: [gps({ accuracyMeters: 250 })], onlineImpl: online });
    await c.goOnline();
    expect(online).not.toHaveBeenCalled();
    expect(c.getState()).toMatchObject({ phase: 'offline', gps: 'weak' });
    expect(c.getState().problem?.code).toBe('WEAK_GPS_ACCURACY');
    expect(c.getState().announcement?.text).toMatch(/250 meters/);
  });

  it('waits for a better fix: improving accuracy within the retries succeeds', async () => {
    const { c } = setup({ fixes: [gps({ accuracyMeters: 300 }), gps({ accuracyMeters: 60 })] });
    await c.goOnline();
    expect(c.getState().phase).toBe('online');
    c.dispose();
  });

  it('reports "GPS unavailable" when no reading can be obtained', async () => {
    const { c } = setup({ fixes: [new Error('no fix')] });
    await c.goOnline();
    expect(c.getState().problem?.code).toBe('GPS_UNAVAILABLE');
    expect(locationStatusKey(c.getState())).toBe('not-sharing');
  });

  it('relays the server’s eligibility reasons and remains offline', async () => {
    const err = Object.assign(new Error('You cannot go online yet.'), {
      code: 'NOT_ELIGIBLE',
      details: { reasons: ['Your driver verification is not complete.'] },
    });
    const { c, client } = setup({ onlineImpl: async () => Promise.reject(err) });
    await c.goOnline();
    expect(c.getState().phase).toBe('offline');
    expect(c.getState().problem?.reasons).toEqual(['Your driver verification is not complete.']);
    expect(c.getState().announcement?.text).toContain('Your driver verification is not complete.');
    expect(client.started).toBe(false); // sharing never began
  });

  it('ignores a second tap while going online (no duplicate request)', async () => {
    const online = vi.fn(async () => status());
    const { c } = setup({ onlineImpl: online });
    const a = c.goOnline();
    const b = c.goOnline();
    await Promise.all([a, b]);
    expect(online).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it('passes the platform mock-location indicator to the server as a flag', async () => {
    const online = vi.fn(async () => status());
    const { c } = setup({ fixes: [gps({ mocked: true })], onlineImpl: online });
    await c.goOnline();
    expect(online).toHaveBeenCalledWith(expect.objectContaining({ mockLocation: true }));
    c.dispose();
  });
});

describe('going offline', () => {
  it('stops sharing first, tells the server, and announces it', async () => {
    const order: string[] = [];
    const { c, client, removed } = setup({
      offlineImpl: async () => {
        order.push('api');
        return status({ state: 'OFFLINE' });
      },
    });
    await c.goOnline();
    client.stop = () => {
      order.push('client');
      client.stopped = true;
    };
    await c.goOffline();
    expect(order).toEqual(['client', 'api']); // broadcasting stops before the request
    expect(removed).toHaveBeenCalled();
    expect(c.getState()).toMatchObject({ phase: 'offline', sharing: 'stopped' });
    expect(c.getState().announcement?.text).toBe(
      'You are now offline. Location sharing has stopped.',
    );
  });

  it('is still offline locally when the server cannot be reached, and says it is unconfirmed', async () => {
    const { c } = setup({ offlineImpl: async () => Promise.reject(new Error('network')) });
    await c.goOnline();
    await c.goOffline();
    expect(c.getState().phase).toBe('offline');
    expect(c.getState().problem?.code).toBe('OFFLINE_UNCONFIRMED');
    expect(c.getState().announcement?.text).toMatch(/could not confirm/);
  });

  it('ignores Go Offline when not online', async () => {
    const offline = vi.fn(async () => status({ state: 'OFFLINE' }));
    const { c } = setup({ offlineImpl: offline });
    await c.goOffline();
    expect(offline).not.toHaveBeenCalled();
  });
});

describe('honest status while online', () => {
  it('only claims sharing while the server keeps acknowledging', async () => {
    const { c, client, pushFix } = setup();
    await c.goOnline();
    client.handlers.onConnection('live');
    expect(locationStatusKey(c.getState())).toBe('updating');

    clock += 40_000; // GPS keeps producing fixes, but the server has not acknowledged for 40 s
    pushFix(gps({ timestampMs: clock }));
    client.handlers.onConnection('live');
    c.tick(clock);
    expect(locationStatusKey(c.getState())).toBe('delayed');
    expect(LOCATION_STATUS_TEXT.delayed).toBe('Location update delayed');

    client.handlers.onMessage({ type: 'location_ack', receivedAt: '', freshness: 'fresh' });
    expect(locationStatusKey(c.getState())).toBe('updating');
    c.dispose();
  });

  it('says the connection is lost — and that nothing is being shared — when the socket drops', async () => {
    const { c, client } = setup();
    await c.goOnline();
    client.handlers.onConnection('live');
    client.handlers.onConnection('reconnecting');
    expect(c.getState().sharing).toBe('connection-lost');
    expect(locationStatusKey(c.getState())).toBe('connection-lost');
    expect(c.getState().announcement).toMatchObject({
      assertive: true,
      text: expect.stringContaining('not being shared'),
    });
    client.handlers.onConnection('live');
    expect(c.getState().sharing).toBe('confirmed');
    expect(c.getState().announcement?.text).toContain('restored');
    c.dispose();
  });

  it('detects GPS loss when readings stop', async () => {
    const { c } = setup();
    await c.goOnline();
    clock += 60_000;
    c.tick(clock);
    expect(c.getState().gps).toBe('lost');
    expect(locationStatusKey(c.getState())).toBe('unavailable');
    c.dispose();
  });

  it('flags weak accuracy without going offline', async () => {
    const { c, pushFix } = setup();
    await c.goOnline();
    clock += 10_000;
    pushFix(gps({ timestampMs: clock, accuracyMeters: 180 }));
    expect(c.getState().gps).toBe('weak');
    expect(locationStatusKey(c.getState())).toBe('weak');
    expect(c.getState().phase).toBe('online');
    c.dispose();
  });

  it('describes the full state in words for a screen reader', async () => {
    const { c, client } = setup();
    await c.goOnline();
    client.handlers.onConnection('live');
    client.handlers.onMessage({ type: 'location_ack', receivedAt: '', freshness: 'fresh' });
    clock += 4000;
    expect(describePresence(c.getState(), clock)).toEqual([
      'Status: Online',
      'Location permission: Granted',
      'Location: Location updating',
      'Current location: Thamel, Kathmandu',
      'Location accuracy: 8 meters',
      'Last update: just now',
      'Connection: Connected',
    ]);
    c.dispose();
  });
});

describe('reacting to the server', () => {
  it('goes offline locally, with the reason, when the server marks the driver stale/unavailable', async () => {
    const { c, client, removed } = setup();
    await c.goOnline();
    client.handlers.onMessage({
      type: 'availability',
      status: status({ state: 'UNAVAILABLE', reason: 'STALE_LOCATION' }),
    });
    expect(c.getState().phase).toBe('offline');
    expect(removed).toHaveBeenCalled();
    expect(client.stopped).toBe(true);
    expect(c.getState().announcement).toMatchObject({
      assertive: true,
      text: expect.stringContaining('stopped receiving your location'),
    });
  });

  it('goes offline when an admin suspends the driver', async () => {
    const { c, client } = setup();
    await c.goOnline();
    client.handlers.onMessage({
      type: 'availability',
      status: status({ state: 'SUSPENDED', reason: 'ACCOUNT_SUSPENDED' }),
    });
    expect(c.getState().phase).toBe('offline');
    expect(c.getState().announcement?.text).toContain('suspended');
  });

  it('stops quietly when another device takes over', async () => {
    const { c, client } = setup();
    await c.goOnline();
    client.handlers.onMessage({ type: 'connection', status: 'superseded', updateIntervalMs: 0 });
    expect(c.getState().phase).toBe('offline');
    expect(c.getState().announcement?.text).toContain('Another device');
  });

  it('resyncs with the server when it rejects a location as "not online"', async () => {
    const statusImpl = vi.fn(async () => status({ state: 'OFFLINE', reason: null }));
    const { c, client } = setup({ statusImpl });
    await c.goOnline();
    client.handlers.onMessage({ type: 'rejected', tripId: '', reason: 'not_online' });
    await flush();
    expect(statusImpl).toHaveBeenCalled();
    expect(c.getState().phase).toBe('offline');
  });

  it('a stale warning from the server makes the status "delayed" while still online', async () => {
    const { c, client } = setup();
    await c.goOnline();
    client.handlers.onConnection('live');
    clock += 45_000;
    client.handlers.onMessage({
      type: 'availability',
      status: status({ locationFreshness: 'stale' }),
    });
    expect(c.getState().phase).toBe('online');
    expect(c.getState().sharing).toBe('delayed');
    c.dispose();
  });

  it('restores an in-progress shift after an app restart', async () => {
    const { c, client } = setup({ statusImpl: async () => status({ state: 'ONLINE' }) });
    await c.restore();
    expect(c.getState().phase).toBe('online');
    expect(client.started).toBe(true);
    c.dispose();
  });

  it('does not restore when the server says offline', async () => {
    const { c } = setup();
    await c.restore();
    expect(c.getState().phase).toBe('offline');
    expect(c.getState().serverStatus?.state).toBe('OFFLINE');
  });
});

describe('battery-conscious behaviour', () => {
  it('reverse geocodes only after real movement and a pause', async () => {
    const geo = vi.fn(async () => 'Somewhere');
    const client = new FakeClient();
    let onFix: ((f: GpsFix) => void) | null = null;
    const c = new DriverPresenceController({
      location: {
        ensurePermission: async () => 'granted',
        servicesEnabled: async () => true,
        getCurrent: async () => gps(),
        watch: async (_o, cb) => {
          onFix = cb;
          return { remove() {} };
        },
      },
      api: {
        online: async () => status(),
        offline: async () => status(),
        status: async () => status(),
      },
      now: () => clock,
      createClient: (h) => {
        client.handlers = h;
        return client;
      },
      reverseGeocode: geo,
    });
    await c.goOnline();
    await flush();
    expect(geo).toHaveBeenCalledTimes(1);

    clock += 20_000;
    onFix!(gps({ timestampMs: clock, latitude: 27.7155 })); // ~11 m, 20 s
    clock += 70_000;
    onFix!(gps({ timestampMs: clock, latitude: 27.7156 })); // still barely moved
    await flush();
    expect(geo).toHaveBeenCalledTimes(1);

    clock += 70_000;
    onFix!(gps({ timestampMs: clock, latitude: 27.72 })); // ~500 m and a minute later
    await flush();
    expect(geo).toHaveBeenCalledTimes(2);
    c.dispose();
  });

  it('dispose releases the GPS watch, timers and socket', async () => {
    const { c, client, removed } = setup();
    await c.goOnline();
    await flush();
    c.dispose();
    expect(removed).toHaveBeenCalled();
    expect(client.stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
