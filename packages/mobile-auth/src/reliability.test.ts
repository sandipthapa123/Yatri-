import { describe, expect, it, vi } from 'vitest';

import { ConnectivityMonitor, OFFLINE_AFTER_FAILURES } from './connectivity';
import { IDEMPOTENCY_RETRY_DELAYS_MS, newIdempotencyKey, withIdempotentRetry } from './idempotency';
import { ServerClock } from './serverClock';
import { shouldEndSession } from './sessionPolicy';

describe('connectivity', () => {
  it('is offline only after repeated failures, and recovers on the first answer', () => {
    let t = 1000;
    const m = new ConnectivityMonitor(() => t);
    const seen: string[] = [];
    m.subscribe(() => seen.push(m.getState().status));
    for (let i = 1; i < OFFLINE_AFTER_FAILURES; i += 1) m.reportUnreachable();
    expect(m.getState().status).toBe('online'); // one blip is not "offline"
    m.reportUnreachable();
    expect(m.getState().status).toBe('offline');
    t = 9000;
    m.reportReachable();
    const s = m.getState();
    expect(s.status).toBe('online');
    expect(s.recoveredAt).toBe(9000);
    expect(s.lastOkAt).toBe(9000);
    expect(s.failures).toBe(0);
    expect(seen).toContain('offline');
  });

  it('counts an error answer from the server as reachable', () => {
    const m = new ConnectivityMonitor();
    m.reportUnreachable();
    m.reportReachable();
    m.reportUnreachable();
    expect(m.getState().status).toBe('online'); // the failure streak was reset by the answer
  });

  it('does not notify when nothing changed', () => {
    const m = new ConnectivityMonitor(() => 1);
    m.reportReachable();
    const listener = vi.fn();
    m.subscribe(listener);
    m.reportReachable(); // same lastOkAt, same state
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('server clock', () => {
  it('corrects a phone clock that is wrong', () => {
    let device = 1_000_000;
    const c = new ServerClock(() => device);
    // The phone is 5 minutes behind: the server says 1_300_000 when the device read 1_000_000 (zero delay).
    c.observe(1_300_000, 1_000_000, 1_000_000);
    expect(c.offset).toBe(300_000);
    device += 10_000;
    expect(c.now()).toBe(1_310_000);
    expect(c.known).toBe(true);
  });

  it('prefers the reading with the least delay and ignores wild values', () => {
    const c = new ServerClock(() => 0);
    c.observe(500, 0, 100); // round trip 100: offset = 500 - 50
    c.observe(10_000, 0, 5000); // a slow answer must not replace it
    expect(c.offset).toBe(450);
    c.observe(Number.NaN, 0, 1);
    expect(c.offset).toBe(450);
  });

  it('is the device time until the server has answered', () => {
    const c = new ServerClock(() => 42);
    expect(c.now()).toBe(42);
    expect(c.known).toBe(false);
  });
});

describe('idempotent retry', () => {
  const net = { status: 0, code: 'NETWORK_ERROR' };
  const noWait = async () => undefined;

  it('retries with the same key after a network failure', async () => {
    const keys: string[] = [];
    const out = await withIdempotentRetry(
      async (key) => {
        keys.push(key);
        if (keys.length < 3) throw net;
        return 'ok';
      },
      { wait: noWait },
    );
    expect(out).toBe('ok');
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('retries "still processing" but never an answer the server gave', async () => {
    let calls = 0;
    await expect(
      withIdempotentRetry(
        async () => {
          calls += 1;
          throw { status: 409, code: 'TRIP_ALREADY_ACTIVE' };
        },
        { wait: noWait },
      ),
    ).rejects.toMatchObject({ code: 'TRIP_ALREADY_ACTIVE' });
    expect(calls).toBe(1);
    let busy = 0;
    const out = await withIdempotentRetry(
      async () => {
        busy += 1;
        if (busy === 1) throw { status: 409, code: 'IDEMPOTENCY_IN_PROGRESS' };
        return 'done';
      },
      { wait: noWait },
    );
    expect(out).toBe('done');
  });

  it('gives up after the last delay and reports the failure', async () => {
    let calls = 0;
    await expect(
      withIdempotentRetry(
        async () => {
          calls += 1;
          throw net;
        },
        { wait: noWait },
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(calls).toBe(IDEMPOTENCY_RETRY_DELAYS_MS.length + 1);
  });

  it('makes keys that are unique and within the server limits', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_.:-]{8,100}$/);
  });
});

describe('when a failure ends the session', () => {
  it('only when the server rejects the credentials', () => {
    expect(shouldEndSession({ status: 401, code: 'INVALID_REFRESH_TOKEN' })).toBe(true);
    expect(shouldEndSession({ status: 403, code: 'FORBIDDEN' })).toBe(true);
    expect(shouldEndSession({ status: 0, code: 'NETWORK_ERROR' })).toBe(false);
    expect(shouldEndSession({ status: 503, code: 'UNAVAILABLE' })).toBe(false);
    expect(shouldEndSession(new TypeError('Network request failed'))).toBe(false);
    expect(shouldEndSession(null)).toBe(false);
  });
});
