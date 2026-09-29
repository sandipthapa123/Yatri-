import { describe, expect, it } from 'vitest';

import { describeResult, describeResultCount, formatAccuracy, formatDistance } from './format';
import { classifyFixError, classifyPermission, isPoorAccuracy } from './permissions';

describe('formatDistance (spoken units)', () => {
  it.each([
    [10, '10 meters'],
    [50, '50 meters'],
    [85, '85 meters'],
    [100, '100 meters'],
    [240.4, '240 meters'],
    [500, '500 meters'],
    [1, '1 meter'],
    [999, '999 meters'],
    [1000, '1 kilometre'],
    [1250, '1.3 kilometres'],
    [5000, '5 kilometres'],
  ])('%s m -> %s', (m, text) => expect(formatDistance(m)).toBe(text));

  it('never produces NaN text', () => {
    expect(formatDistance(NaN)).toBe('unknown distance');
    expect(formatDistance(-5)).toBe('unknown distance');
  });
});

describe('accessible descriptions', () => {
  it('describes results with position', () => {
    expect(describeResult({ name: 'Thamel', address: 'Kathmandu, Bagmati Province' }, 0, 5)).toBe(
      'Thamel, Kathmandu, Bagmati Province. Result 1 of 5.',
    );
  });
  it('announces counts and empty results helpfully', () => {
    expect(describeResultCount(1, 'x')).toContain('1 result found');
    expect(describeResultCount(3, 'x')).toContain('3 results found');
    expect(describeResultCount(0, 'thamle')).toContain('No places found for thamle');
  });
  it('states accuracy in words', () => {
    expect(formatAccuracy(14.6)).toBe('Location accuracy approximately 15 meters.');
    expect(formatAccuracy(null)).toBeNull();
  });
});

describe('location permission / error classification', () => {
  it('separates denied (can ask again) from blocked (Settings only)', () => {
    expect(classifyPermission({ granted: true, canAskAgain: true })).toBe('granted');
    expect(classifyPermission({ granted: false, canAskAgain: true })).toBe('denied');
    expect(classifyPermission({ granted: false, canAskAgain: false })).toBe('blocked');
  });
  it('classifies GPS failures', () => {
    expect(classifyFixError(new Error('timeout'))).toBe('timeout');
    expect(classifyFixError({ code: 'E_LOCATION_SETTINGS_UNSATISFIED' })).toBe('services-off');
    expect(classifyFixError(new Error('Location services are disabled'))).toBe('services-off');
    expect(classifyFixError(new Error('kCLErrorLocationUnknown'))).toBe('unavailable');
    expect(classifyFixError(null)).toBe('unavailable');
  });
  it('flags poor or unknown accuracy', () => {
    expect(isPoorAccuracy(15)).toBe(false);
    expect(isPoorAccuracy(100)).toBe(false);
    expect(isPoorAccuracy(250)).toBe(true);
    expect(isPoorAccuracy(null)).toBe(true);
    expect(isPoorAccuracy(NaN)).toBe(true);
  });
});
