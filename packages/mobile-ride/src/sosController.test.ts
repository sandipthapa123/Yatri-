import type { ServerRealtimeMessage, SosInfo } from '@yatri/types';
import { describe, expect, it, vi } from 'vitest';

import { SOS_FAILED_TEXT, SosController } from './sosController';

const sos = (status: SosInfo['status'], over: Partial<SosInfo> = {}): SosInfo => ({
  id: 's1',
  tripId: 't1',
  status,
  createdAt: '2026-01-01T00:00:00Z',
  locationRecorded: true,
  contactsNotified: 0,
  emergencyNumber: '100',
  ...over,
});

type Fix = { latitude: number; longitude: number; accuracyMeters: number | null } | null;
function harness(
  over: {
    mine?: () => Promise<SosInfo | null>;
    raise?: (b: object) => Promise<SosInfo>;
    cancel?: () => Promise<SosInfo>;
    getPosition?: () => Promise<Fix>;
  } = {},
) {
  let onMsg: (m: ServerRealtimeMessage) => void = () => undefined;
  let onConn: (c: string) => void = () => undefined;
  const c = new SosController({
    tripId: 't1',
    socket: {
      onMessage: (l) => {
        onMsg = l;
        return () => undefined;
      },
      onConnectionChange: (l) => {
        onConn = l;
        return () => undefined;
      },
    },
    api: {
      mine: over.mine ?? (async () => null),
      raise: over.raise ?? (async () => sos('ACTIVE')),
      cancel: over.cancel ?? (async () => sos('CANCELLED')),
    },
    getPosition: over.getPosition,
  });
  c.start();
  return { c, push: (m: ServerRealtimeMessage) => onMsg(m), connect: () => onConn('live') };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SosController', () => {
  it('raises the alert with a quick position and says so at once', async () => {
    const raise = vi.fn(async (_b: object) => sos('ACTIVE', { contactsNotified: 2 }));
    const { c } = harness({
      raise,
      getPosition: async () => ({ latitude: 27.7, longitude: 85.3, accuracyMeters: 10 }),
    });
    expect(await c.raise()).toBe(true);
    expect(raise).toHaveBeenCalledWith({ latitude: 27.7, longitude: 85.3, accuracyMeters: 10 });
    expect(c.getState().assertive?.text).toContain('2 emergency contacts have been sent a link');
  });

  it('is never held up by a missing or failing position', async () => {
    const raise = vi.fn(async (_b: object) => sos('ACTIVE'));
    const { c } = harness({ raise, getPosition: async () => null });
    await c.raise();
    expect(raise).toHaveBeenCalledWith({});
    const broken = harness({
      raise,
      getPosition: async () => {
        throw new Error('gps');
      },
    });
    expect(await broken.c.raise()).toBe(true);
  });

  it('cannot be raised twice: a press while sending or once on record does nothing', async () => {
    const raise = vi.fn(async (_b: object) => {
      await flush();
      return sos('ACTIVE');
    });
    const { c } = harness({ raise });
    const [a, b] = await Promise.all([c.raise(), c.raise()]);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(a).toBe(true);
    expect(b).toBe(false);
    await c.raise();
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('a failure is spoken and points at the phone call, never silent', async () => {
    const { c } = harness({
      raise: async () => {
        throw new Error('offline');
      },
    });
    expect(await c.raise()).toBe(false);
    expect(c.getState().error).toBe(SOS_FAILED_TEXT('100'));
    expect(c.getState().assertive?.text).toContain('Call 100 now');
    expect(c.getState().busy).toBeNull();
  });

  it('announces each change the server pushes once, and only for this ride', async () => {
    const { c, push } = harness();
    await c.raise();
    const first = c.getState().assertive?.id;
    push({ type: 'sos_state', sos: sos('ACTIVE') });
    expect(c.getState().assertive?.id).toBe(first);
    push({ type: 'sos_state', sos: sos('ACKNOWLEDGED') });
    expect(c.getState().assertive?.text).toBe(
      'The Yatri safety team has seen your alert and is responding.',
    );
    push({ type: 'sos_state', sos: sos('RESOLVED', { tripId: 'other', id: 's9' }) });
    expect(c.getState().sos?.status).toBe('ACKNOWLEDGED');
  });

  it('cancels only an open alert and reports the server result', async () => {
    const cancel = vi.fn(async () => sos('CANCELLED'));
    const { c } = harness({ cancel });
    expect(await c.cancel()).toBe(false);
    await c.raise();
    expect(await c.cancel()).toBe(true);
    expect(c.getState().sos?.status).toBe('CANCELLED');
    expect(c.getState().assertive?.text).toBe('You cancelled the emergency alert.');
    expect(await c.cancel()).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('picks up an alert after a reconnect without repeating what it already said', async () => {
    let current: SosInfo | null = null;
    const { c, connect } = harness({ mine: async () => current });
    await flush();
    connect();
    current = sos('ACKNOWLEDGED');
    connect();
    await flush();
    expect(c.getState().sos?.status).toBe('ACKNOWLEDGED');
    expect(c.getState().assertive?.text).toContain('responding');
    const id = c.getState().assertive?.id;
    connect();
    await flush();
    expect(c.getState().assertive?.id).toBe(id);
  });

  it('a failed cancel leaves the alert standing and says so', async () => {
    const { c } = harness({
      cancel: async () => {
        throw new Error('x');
      },
    });
    await c.raise();
    expect(await c.cancel()).toBe(false);
    expect(c.getState().sos?.status).toBe('ACTIVE');
    expect(c.getState().error).toBe('Could not cancel the alert. Please try again.');
  });
});
