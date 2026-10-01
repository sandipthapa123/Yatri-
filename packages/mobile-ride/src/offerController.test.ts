import type { ServerRealtimeMessage, TripOfferInfo } from '@yatri/types';
import { describe, expect, it, vi } from 'vitest';

import {
  OfferController,
  describeOffer,
  offerSecondsLeft,
  type OfferSocket,
} from './offerController';

const place = (name: string) => ({ name, address: '', latitude: 27.7, longitude: 85.3 });
const offer = (id = 'o1', over: Partial<TripOfferInfo> = {}): TripOfferInfo => ({
  offerId: id,
  tripId: 't1',
  pickup: place('Thamel'),
  destination: place('Patan'),
  pickupDistanceMeters: 450,
  tripDistanceMeters: 5300,
  fareEstimateNpr: 320,
  vehicleCategory: null,
  serverTime: '2026-01-01T10:00:00.000Z',
  expiresAt: '2026-01-01T10:00:20.000Z',
  vehicleNeeds: [],
  ...over,
});

class FakeSocket implements OfferSocket {
  private ml = new Set<(m: ServerRealtimeMessage) => void>();
  private cl = new Set<(c: string) => void>();
  onMessage(l: (m: ServerRealtimeMessage) => void) {
    this.ml.add(l);
    return () => this.ml.delete(l);
  }
  onConnectionChange(l: (c: string) => void) {
    this.cl.add(l);
    return () => this.cl.delete(l);
  }
  push(m: ServerRealtimeMessage) {
    this.ml.forEach((l) => l(m));
  }
  connection(c: string) {
    this.cl.forEach((l) => l(c));
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(initial: TripOfferInfo | null = null) {
  const socket = new FakeSocket();
  let current = initial;
  const api = {
    currentOffer: vi.fn(async () => current),
    respond: vi.fn(async (_id: string, accept: boolean) => ({
      accepted: accept,
      trip: accept ? ({ id: 't1' } as never) : null,
    })),
  };
  const c = new OfferController({ socket, api, now: () => 1_000_000 });
  c.start();
  return { c, socket, api, setCurrent: (o: TripOfferInfo | null) => (current = o) };
}

describe('offer countdown', () => {
  it('counts from the server clock, not the device clock', () => {
    const o = offer();
    expect(offerSecondsLeft(o, 5_000, 5_000)).toBe(20);
    expect(offerSecondsLeft(o, 5_000, 12_000)).toBe(13); // 7 s after arrival
    expect(offerSecondsLeft(o, 5_000, 99_000)).toBe(0); // never negative
    // a phone whose clock is far off gives the same answer, because only elapsed time is used
    expect(offerSecondsLeft(o, 9_000_000_000, 9_000_007_000)).toBe(13);
  });

  it('names the vehicle type when the ride has one', () => {
    expect(
      describeOffer(offer('o1', { vehicleCategory: { code: 'SUV', label: 'SUV' } }), 20),
    ).toMatch(/^New SUV ride request\. Pickup Thamel/);
  });

  it('words an offer completely, with distances in words', () => {
    expect(describeOffer(offer(), 20)).toBe(
      'New ride request. Pickup Thamel, 450 meters from you. Destination Patan, 5.3 kilometres trip. Fare NPR 320. Respond within 20 seconds.',
    );
  });
});

describe('OfferController', () => {
  it('announces a pushed offer assertively, once, and clears it when the server closes it', async () => {
    const { c, socket } = setup();
    await flush();
    socket.push({ type: 'trip_offer', offer: offer() });
    socket.push({ type: 'trip_offer', offer: offer() }); // duplicate push
    expect(c.getState().offer?.offerId).toBe('o1');
    expect(c.getState().assertive?.id).toBe(1);
    expect(c.getState().assertive?.text).toContain('New ride request. Pickup Thamel');

    socket.push({ type: 'trip_offer_closed', offerId: 'o1', reason: 'EXPIRED' });
    expect(c.getState().offer).toBeNull();
    expect(c.getState().polite?.text).toBe('The ride request expired.');
    socket.push({ type: 'trip_offer', offer: offer('o2') });
    socket.push({ type: 'trip_offer_closed', offerId: 'o2', reason: 'TAKEN' });
    expect(c.getState().polite?.text).toBe('Another driver took this ride.');
  });

  it('ignores the closing of an offer it is not showing', async () => {
    const { c, socket } = setup();
    await flush();
    socket.push({ type: 'trip_offer', offer: offer('o2') });
    socket.push({ type: 'trip_offer_closed', offerId: 'other', reason: 'EXPIRED' });
    expect(c.getState().offer?.offerId).toBe('o2');
  });

  it('shows an offer that was waiting when the app opened, silently, and re-reads after a reconnect', async () => {
    const { c, socket, setCurrent } = setup(offer());
    await flush();
    expect(c.getState().offer?.offerId).toBe('o1');
    expect(c.getState().assertive).toBeNull(); // opening the app is not news

    socket.connection('live'); // first connect
    setCurrent(offer('o3'));
    socket.connection('live'); // reconnect: an offer pushed while offline must not be lost
    await flush();
    expect(c.getState().offer?.offerId).toBe('o3');
    expect(c.getState().assertive?.text).toContain('New ride request');
  });

  it('accepts (returning the trip) and declines, and only responds once at a time', async () => {
    const { c, socket, api } = setup();
    await flush();
    socket.push({ type: 'trip_offer', offer: offer() });
    const [a, b] = await Promise.all([c.accept(), c.accept()]);
    expect(api.respond).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ id: 't1' });
    expect(b).toBeNull();
    expect(c.getState().offer).toBeNull();

    socket.push({ type: 'trip_offer', offer: offer('o2') });
    await c.decline();
    expect(api.respond).toHaveBeenLastCalledWith('o2', false);
  });

  it('says so when the ride is gone by the time the driver answers', async () => {
    const { c, socket, api } = setup();
    await flush();
    socket.push({ type: 'trip_offer', offer: offer() });
    api.respond.mockResolvedValueOnce({ accepted: false, trip: null });
    expect(await c.accept()).toBeNull();
    expect(c.getState().polite?.text).toBe('That ride is no longer available.');

    socket.push({ type: 'trip_offer', offer: offer('o2') });
    api.respond.mockRejectedValueOnce(new Error('This request has expired.'));
    expect(await c.accept()).toBeNull();
    expect(c.getState().error).toBe('This request has expired.');
    expect(c.getState().offer).toBeNull();
  });
});
