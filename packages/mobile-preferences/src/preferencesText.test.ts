import { LARGER_TOUCH_SCALE, PREFERENCE_DEFS, TEXT_SCALE, preferenceDef } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { savedNews, settingsSections, toUiPreferences, valueWords } from './preferencesText';

const prefs = (values: Record<string, string | boolean | null>) => ({ values });

describe('turning the server preferences into what the shared components read', () => {
  it('uses the defaults until preferences have loaded', () => {
    expect(toUiPreferences(null, false)).toEqual({
      scheme: null,
      fontScale: 1,
      touchScale: 1,
      reducedMotion: false,
      speakUpdates: true,
      confirmBeforeSos: true,
      hapticFeedback: true,
      simplifiedNavigation: false,
    });
  });
  it('maps vibration feedback and simpler screens, which the person can switch', () => {
    const ui = toUiPreferences(prefs({ hapticFeedback: false, simplifiedNavigation: true }), false);
    expect(ui.hapticFeedback).toBe(false);
    expect(ui.simplifiedNavigation).toBe(true);
  });
  it('maps theme, text size, larger buttons and speaking from the one table', () => {
    const ui = toUiPreferences(
      prefs({
        theme: 'DARK',
        textSize: 'EXTRA_LARGE',
        largerTouchTargets: true,
        speakUpdates: false,
        confirmBeforeSos: false,
      }),
      false,
    );
    expect(ui).toMatchObject({
      scheme: 'dark',
      fontScale: TEXT_SCALE.EXTRA_LARGE,
      touchScale: LARGER_TOUCH_SCALE,
      speakUpdates: false,
      confirmBeforeSos: false,
    });
    expect(toUiPreferences(prefs({ theme: 'LIGHT' }), true).scheme).toBe('light');
    expect(toUiPreferences(prefs({ theme: 'SYSTEM' }), true).scheme).toBeNull();
  });
  it('lets the person’s choice about motion beat the phone’s, and follows the phone otherwise', () => {
    expect(toUiPreferences(prefs({ reducedMotion: 'SYSTEM' }), true).reducedMotion).toBe(true);
    expect(toUiPreferences(prefs({ reducedMotion: 'SYSTEM' }), false).reducedMotion).toBe(false);
    expect(toUiPreferences(prefs({ reducedMotion: 'ON' }), false).reducedMotion).toBe(true);
    expect(toUiPreferences(prefs({ reducedMotion: 'OFF' }), true).reducedMotion).toBe(false);
  });
});

describe('the settings screen is built from the definitions', () => {
  it('shows each role its own groups in order, and lists every setting once', () => {
    const passenger = settingsSections('PASSENGER');
    const driver = settingsSections('DRIVER');
    expect(passenger.map((s) => s.group)).toEqual([
      'appearance',
      'language',
      'accessibility',
      'notifications',
      'privacy',
      'safety',
      'rides',
    ]);
    expect(driver.map((s) => s.group)).toEqual([
      'appearance',
      'language',
      'accessibility',
      'notifications',
      'safety',
    ]);
    for (const sections of [passenger, driver]) {
      const keys = sections.flatMap((s) => s.defs.map((d) => d.key));
      expect(new Set(keys).size).toBe(keys.length);
    }
    const all = new Set([...passenger, ...driver].flatMap((s) => s.defs.map((d) => d.key)));
    expect([...all].sort()).toEqual(PREFERENCE_DEFS.map((d) => d.key).sort());
  });
  it('says what is chosen in words, never a bare code', () => {
    expect(valueWords(preferenceDef('theme')!, 'DARK')).toBe('Dark');
    expect(valueWords(preferenceDef('largerTouchTargets')!, true)).toBe('On');
    expect(valueWords(preferenceDef('largerTouchTargets')!, false)).toBe('Off');
    expect(valueWords(preferenceDef('defaultVehicle')!, null)).toBe('No preference');
    expect(valueWords(preferenceDef('language')!, 'en')).toBe('English');
    expect(savedNews(preferenceDef('textSize')!, 'LARGE')).toBe('Text size: Large. Saved.');
  });
});
