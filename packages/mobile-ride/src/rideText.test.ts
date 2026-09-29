import { describe, expect, it } from 'vitest';

import { mapsUrl, ratingText } from './rideText';

describe('ride text helpers', () => {
  it('says a rating in words, and is honest when there is none yet', () => {
    expect(ratingText(null)).toBe('No ratings yet');
    expect(ratingText(4.666)).toBe('Rating 4.7 out of 5');
    expect(ratingText(5)).toBe('Rating 5.0 out of 5');
  });

  it("opens the platform's own maps app on the server's coordinates", () => {
    const target = { latitude: 27.7154, longitude: 85.3123 };
    expect(mapsUrl(target, 'Navigate to the pickup', 'ios')).toBe(
      'http://maps.apple.com/?daddr=27.7154,85.3123&dirflg=d',
    );
    expect(mapsUrl(target, 'Navigate to the pickup', 'android')).toBe(
      'geo:0,0?q=27.7154,85.3123(Navigate%20to%20the%20pickup)',
    );
  });
});
