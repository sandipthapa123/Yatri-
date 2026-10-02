import { bearingDegrees, type AccessibilityProfile, type LiveTripSnapshot } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import {
  NO_ACCESSIBLE_VEHICLE_TEXT,
  capabilitySavedNews,
  capabilityWords,
  pickupGuide,
  profileSummary,
  requestAccessibilityLine,
} from './accessibilityText';

const empty: AccessibilityProfile = {
  companion: false,
  needs: [],
  communication: 'ANY',
  pickupInstructions: [],
  pickupNote: null,
  otherNote: null,
  version: 0,
  updatedAt: null,
};

describe('bearing', () => {
  const origin = { latitude: 27.7, longitude: 85.3 };
  it('points the way a person would say it', () => {
    expect(Math.round(bearingDegrees(origin, { latitude: 27.8, longitude: 85.3 }))).toBe(0);
    expect(Math.round(bearingDegrees(origin, { latitude: 27.7, longitude: 85.4 }))).toBe(90);
    expect(Math.round(bearingDegrees(origin, { latitude: 27.6, longitude: 85.3 }))).toBe(180);
    expect(Math.round(bearingDegrees(origin, { latitude: 27.7, longitude: 85.2 }))).toBe(270);
  });
});

describe('what a passenger sees about their own settings', () => {
  it('says plainly when nothing is set, and never assumes', () => {
    expect(profileSummary(empty)).toContain('No accessibility needs are set');
    expect(requestAccessibilityLine(empty)).toBeNull();
    expect(requestAccessibilityLine(null)).toBeNull();
  });

  it('lists what they chose in their own words, and says how matching treats a vehicle need', () => {
    const p: AccessibilityProfile = {
      ...empty,
      needs: ['WHEELCHAIR', 'HEARING'],
      communication: 'TEXT_ONLY',
      pickupInstructions: ['CANNOT_USE_STAIRS'],
      pickupNote: 'Blue gate',
    };
    const text = profileSummary(p);
    expect(text).toContain('wheelchair');
    expect(text).toContain('Messages only');
    expect(text).toContain('Pickup note: Blue gate');
    const line = requestAccessibilityLine(p) ?? '';
    expect(line).toContain('Only drivers whose vehicle is approved');
    expect(line).toContain('Settings');
    // A need without a vehicle requirement does not promise filtering it will not do.
    expect(requestAccessibilityLine({ ...empty, needs: ['ASSISTANCE'] })).not.toContain(
      'Only drivers',
    );
  });

  it('has a sentence for "no accessible vehicle nearby" that does not blame or hide', () => {
    expect(NO_ACCESSIBLE_VEHICLE_TEXT).toContain('No accessible vehicle is available');
    expect(NO_ACCESSIBLE_VEHICLE_TEXT).toContain('keep looking');
  });
});

describe('what a driver sees about a vehicle feature', () => {
  const cap = (
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | null,
    reason: string | null = null,
  ) => ({
    code: 'X',
    label: 'X',
    help: '',
    requiresApproval: true,
    status,
    decisionReason: reason,
  });
  it("uses words for every state, with the reviewer's reason when not approved", () => {
    expect(capabilityWords(cap(null))).toBe('Not declared');
    expect(capabilityWords(cap('PENDING'))).toBe('Waiting for approval');
    expect(capabilityWords(cap('APPROVED'))).toBe('Approved');
    expect(capabilityWords(cap('REJECTED', 'The ramp is missing'))).toBe(
      'Not approved: The ramp is missing',
    );
  });
  it('tells the driver what is still waiting', () => {
    expect(capabilitySavedNews([cap('APPROVED')])).toBe('Saved.');
    expect(capabilitySavedNews([cap('PENDING')])).toContain('1 feature is waiting for approval');
    expect(capabilitySavedNews([cap('PENDING'), cap('PENDING')])).toContain(
      '2 features are waiting',
    );
  });
});

describe('the text version of the pickup', () => {
  const snap = (over: Partial<LiveTripSnapshot>): LiveTripSnapshot => ({
    tripId: 't',
    status: 'DRIVER_EN_ROUTE',
    version: 1,
    lastEventSeq: 1,
    serverTime: new Date().toISOString(),
    pickup: {
      name: 'Thamel Chowk',
      address: 'Thamel, Kathmandu',
      latitude: 27.7154,
      longitude: 85.3123,
    },
    destination: { name: 'Patan', address: 'Patan', latitude: 27.67, longitude: 85.32 },
    driver: {
      latitude: 27.7154,
      longitude: 85.3163, // east of the pickup
      accuracyMeters: 8,
      headingDegrees: 270,
      updatedAt: new Date().toISOString(),
      ageSeconds: 3,
      freshness: 'live',
      placeName: 'Tridevi Marg',
      placeKind: 'road',
      placeStale: false,
    },
    passenger: null,
    driverArrival: { distanceMeters: 420, etaSeconds: 150, basis: 'route' },
    trip: null,
    waiting: null,
    navigation: null,
    ...over,
  });
  const vehicle = { description: 'White Toyota Corolla', registrationNumber: 'BA 1 KHA 1234' };

  it('gives address, landmark, direction, distance, time and the vehicle to look for', () => {
    const rows = pickupGuide(snap({}), vehicle);
    const text = rows.map((r) => `${r.label}: ${r.value}`).join(' | ');
    expect(text).toContain('Pickup address: Thamel, Kathmandu');
    expect(text).toContain('Landmark: Thamel Chowk');
    expect(text).toContain('420 meters to the east of the pickup, near Tridevi Marg');
    expect(text).toContain('Arriving in: 3 minutes');
    expect(text).toContain('Look for: White Toyota Corolla, number plate BA 1 KHA 1234');
  });

  it('says "at the pickup" when the driver is there, and does not invent a direction when it has no driver', () => {
    const arrived = pickupGuide(snap({ status: 'DRIVER_ARRIVED', driverArrival: null }), vehicle);
    expect(arrived.some((r) => r.value.includes('waiting for you'))).toBe(true);
    const none = pickupGuide(snap({ driver: null, driverArrival: null }), null);
    expect(none.map((r) => r.label)).toEqual(['Pickup address', 'Landmark']);
  });
});
