import { describe, expect, it } from 'vitest';

import { haversineMeters } from '../modules/location/geo';
import { estimateEta } from '../modules/tracking/eta';
import { trackingConfig } from '../modules/tracking/tracking.config';
import {
  evaluateFix,
  freshnessOf,
  shouldRefreshPlaceName,
  type Fix,
  type StoredFix,
} from '../modules/tracking/tracking.rules';

const KTM = { latitude: 27.7172, longitude: 85.324 };
const NOW = 1_800_000_000_000;

/** A point `meters` due north of `from` (1° latitude ≈ 111 195 m). */
const north = (from: { latitude: number; longitude: number }, meters: number) => ({
  latitude: from.latitude + meters / 111_195,
  longitude: from.longitude,
});

const fix = (over: Partial<Fix> = {}): Fix => ({
  ...KTM,
  accuracyMeters: 8,
  deviceTimeMs: NOW,
  ...over,
});
const stored = (over: Partial<StoredFix> = {}): StoredFix => ({
  ...fix(),
  receivedAtMs: NOW,
  ...over,
});
const cfg = { ...trackingConfig(), minIntervalMs: 0 };

describe('mocked GPS distances', () => {
  it.each([10, 50, 100, 500, 1000, 5000])('measures %s m within 0.5%', (d) => {
    const measured = haversineMeters(KTM, north(KTM, d));
    expect(Math.abs(measured - d) / d).toBeLessThan(0.005);
  });

  it.each([
    [10, 2],
    [50, 5],
    [100, 10],
    [500, 30],
    [1000, 60],
    [5000, 300],
  ])('accepts a %s m move taking %s s (a plausible drive)', (d, seconds) => {
    const d1 = evaluateFix(
      stored(),
      fix({ ...north(KTM, d), deviceTimeMs: NOW + seconds * 1000 }),
      NOW + seconds * 1000,
      cfg,
    );
    expect(d1.accept).toBe(true);
  });
});

describe('evaluateFix', () => {
  it('accepts the first fix', () => {
    const d = evaluateFix(null, fix(), NOW, cfg);
    expect(d.accept).toBe(true);
    if (d.accept) expect(d.next.receivedAtMs).toBe(NOW);
  });

  it('rejects duplicates and out-of-order fixes', () => {
    expect(evaluateFix(stored(), fix(), NOW + 1000, cfg)).toMatchObject({
      accept: false,
      reason: 'duplicate',
    });
    expect(
      evaluateFix(
        stored({ deviceTimeMs: NOW + 5000 }),
        fix({ deviceTimeMs: NOW + 2000 }),
        NOW + 6000,
        cfg,
      ),
    ).toMatchObject({ accept: false, reason: 'out_of_order' });
  });

  it('drops a late-delivered (stale) reading and a fix from a broken future clock', () => {
    expect(evaluateFix(null, fix({ deviceTimeMs: NOW - 31_000 }), NOW, cfg)).toMatchObject({
      accept: false,
      reason: 'stale',
    });
    expect(evaluateFix(null, fix({ deviceTimeMs: NOW + 61_000 }), NOW, cfg)).toMatchObject({
      accept: false,
      reason: 'clock_skew',
    });
  });

  it('rate limits per party', () => {
    const c = { ...trackingConfig(), minIntervalMs: 800 };
    expect(evaluateFix(stored(), fix({ deviceTimeMs: NOW + 100 }), NOW + 100, c)).toMatchObject({
      accept: false,
      reason: 'too_frequent',
    });
  });

  it('rejects malformed values', () => {
    for (const bad of [
      fix({ latitude: NaN }),
      fix({ longitude: Infinity }),
      fix({ latitude: 91 }),
      fix({ latitude: 0, longitude: 0 }),
      fix({ accuracyMeters: -1 }),
      fix({ deviceTimeMs: NaN }),
    ]) {
      expect(evaluateFix(null, bad, NOW, cfg)).toMatchObject({ accept: false, reason: 'invalid' });
    }
  });

  it('never uses a very poor fix, and does not swap a good recent fix for a much worse one', () => {
    expect(evaluateFix(null, fix({ accuracyMeters: 500 }), NOW, cfg)).toMatchObject({
      accept: false,
      reason: 'low_accuracy',
    });
    expect(
      evaluateFix(
        stored({ accuracyMeters: 5 }),
        fix({ accuracyMeters: 120, deviceTimeMs: NOW + 2000 }),
        NOW + 2000,
        cfg,
      ),
    ).toMatchObject({ accept: false, reason: 'low_accuracy' });
    // …but a similar-quality fix is fine
    expect(
      evaluateFix(
        stored({ accuracyMeters: 5 }),
        fix({ accuracyMeters: 20, deviceTimeMs: NOW + 2000 }),
        NOW + 2000,
        cfg,
      ).accept,
    ).toBe(true);
  });

  it('rejects an impossible jump but keeps the last good position', () => {
    const jump = evaluateFix(
      stored(),
      fix({ ...north(KTM, 20_000), deviceTimeMs: NOW + 2000 }),
      NOW + 2000,
      cfg,
    );
    expect(jump.accept).toBe(false);
    if (!jump.accept) {
      expect(jump.reason).toBe('impossible_jump');
      expect(jump.next?.latitude).toBe(KTM.latitude); // baseline untouched
      expect(jump.next?.pendingJump?.count).toBe(1);
    }
  });

  it('accepts the new location once the device keeps reporting from there (the old fix was wrong)', () => {
    const far = north(KTM, 20_000);
    let state = stored();
    let t = NOW;
    let accepted = false;
    for (let i = 1; i <= 3; i++) {
      t += 2000;
      const d = evaluateFix(state, fix({ ...far, deviceTimeMs: t }), t, cfg);
      if (d.accept) {
        accepted = true;
        expect(i).toBe(3);
        expect(d.next.pendingJump).toBeUndefined();
      } else if (d.next) {
        state = d.next;
      }
    }
    expect(accepted).toBe(true);
  });

  it('does not let scattered wild fixes take over', () => {
    let state = stored();
    let t = NOW;
    for (const meters of [20_000, 40_000, 60_000, 80_000]) {
      t += 2000;
      const d = evaluateFix(state, fix({ ...north(KTM, meters), deviceTimeMs: t }), t, cfg);
      expect(d.accept).toBe(false);
      if (!d.accept && d.next) state = d.next;
    }
  });

  it('allows a long gap to cover real distance (GPS loss in a tunnel: 1.2 km in 25 s)', () => {
    const d = evaluateFix(
      stored(),
      fix({ ...north(KTM, 1200), deviceTimeMs: NOW + 25_000 }),
      NOW + 25_000,
      cfg,
    );
    expect(d.accept).toBe(true);
  });
});

describe('freshness & place-name thresholds', () => {
  it('classifies live / stale / lost / none', () => {
    const c = trackingConfig(); // thresholds come from config: live <= 30 s, stale <= 60 s by default
    expect(freshnessOf(null, NOW, c)).toBe('none');
    expect(freshnessOf(NOW - 5_000, NOW, c)).toBe('live');
    expect(freshnessOf(NOW - 30_000, NOW, c)).toBe('live');
    expect(freshnessOf(NOW - 45_000, NOW, c)).toBe('stale');
    expect(freshnessOf(NOW - 61_000, NOW, c)).toBe('lost');
  });

  it('refreshes the place name only after real movement and a pause', () => {
    const last = { ...KTM, atMs: NOW };
    expect(shouldRefreshPlaceName(null, KTM, NOW)).toBe(true);
    expect(shouldRefreshPlaceName(last, north(KTM, 200), NOW + 5_000)).toBe(false); // too soon
    expect(shouldRefreshPlaceName(last, north(KTM, 20), NOW + 60_000)).toBe(false); // barely moved
    expect(shouldRefreshPlaceName(last, north(KTM, 200), NOW + 20_000)).toBe(true);
  });
});

describe('estimateEta', () => {
  it('produces sensible, monotonic times and clamps silly speeds', () => {
    const a = estimateEta(100).etaSeconds;
    const b = estimateEta(1000).etaSeconds;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(estimateEta(1000, 0.1).etaSeconds).toBe(estimateEta(1000, 3).etaSeconds);
    expect(estimateEta(1000, 90).etaSeconds).toBe(estimateEta(1000, 16).etaSeconds);
    expect(estimateEta(0).etaSeconds).toBe(0);
  });
});
