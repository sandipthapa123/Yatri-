import { TRIP_EVENT_TYPES, describeTripEvent, type EventViewer } from '@yatri/types';
import { describe, expect, it } from 'vitest';

const say = (type: (typeof TRIP_EVENT_TYPES)[number], viewer: EventViewer, payload = {}) =>
  describeTripEvent({ type, payload }, viewer);

describe('one wording per event, per audience', () => {
  it('speaks to the passenger, the driver and the admin in the right voice', () => {
    expect(say('DRIVER_ARRIVED', 'PASSENGER')).toBe('Your driver has arrived.');
    expect(say('DRIVER_ARRIVED', 'DRIVER')).toBe('You have arrived at the pickup.');
    expect(say('DRIVER_ARRIVED', 'ADMIN')).toBe('Driver arrived at the pickup.');

    expect(say('TRIP_STARTED', 'PASSENGER')).toBe('Your ride has started.');
    expect(say('TRIP_STARTED', 'ADMIN')).toBe('Ride started.');

    expect(say('DRIVER_WAITING', 'PASSENGER', { seconds: 120 })).toBe(
      'Your driver has been waiting for 2 minutes.',
    );
    expect(say('PASSENGER_WAITING', 'PASSENGER', { seconds: 180 })).toBe(
      'You have been waiting for 3 minutes.',
    );
    expect(say('DRIVER_WAITING', 'DRIVER', { seconds: 120 })).toBe(
      'You have been waiting for 2 minutes.',
    );
    expect(say('DRIVER_WAITING', 'ADMIN', { seconds: 120 })).toBe(
      'Driver has been waiting for 2 minutes.',
    );
    expect(say('PASSENGER_WAITING', 'ADMIN', { seconds: 180 })).toBe(
      'The passenger has been waiting for 3 minutes.',
    );
  });

  it('names who cancelled from each point of view', () => {
    const by = (b: string, viewer: EventViewer) =>
      say('TRIP_CANCELLED', viewer, { by: b, reason: 'Plans changed' });
    expect(by('PASSENGER', 'PASSENGER')).toBe(
      'The ride was cancelled by you. Reason: Plans changed.',
    );
    expect(by('PASSENGER', 'DRIVER')).toBe(
      'The ride was cancelled by the passenger. Reason: Plans changed.',
    );
    expect(by('PASSENGER', 'ADMIN')).toBe(
      'The ride was cancelled by the passenger. Reason: Plans changed.',
    );
    expect(by('DRIVER', 'ADMIN')).toBe(
      'The ride was cancelled by the driver. Reason: Plans changed.',
    );
    expect(by('SYSTEM', 'PASSENGER')).toBe(
      'The ride was cancelled by Yatri. Reason: Plans changed.',
    );
  });

  it('never uses "you/your" in the admin timeline', () => {
    for (const type of TRIP_EVENT_TYPES) {
      const text = say(type, 'ADMIN', {
        seconds: 60,
        distanceMeters: 100,
        fareNpr: 200,
        amountNpr: 200,
        by: 'DRIVER',
      });
      expect(text, type).not.toMatch(/\b(you|your)\b/i);
    }
  });

  it('has words for every event type, for every audience', () => {
    for (const type of TRIP_EVENT_TYPES) {
      for (const viewer of ['PASSENGER', 'DRIVER', 'ADMIN'] as const) {
        expect(say(type, viewer).length, `${type}/${viewer}`).toBeGreaterThan(3);
      }
    }
  });
});
