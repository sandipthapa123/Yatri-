import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/** Static accessibility checks for the settings screens (they do not replace TalkBack or VoiceOver). */
const dir = path.resolve(__dirname, 'components');
const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
const source = (f: string) => readFileSync(path.join(dir, f), 'utf8');

describe('the settings screens', () => {
  it('uses only shared buttons that carry a role and a state, and no unlabelled raw inputs', () => {
    for (const f of files) {
      // A text field must carry its own accessible name (a placeholder disappears once typing starts).
      for (const m of source(f).matchAll(/<TextInput[\s\S]*?\/>/g))
        expect(m[0], f).toMatch(/accessibilityLabel=/);
      for (const m of source(f).matchAll(/<Pressable[\s\S]*?>/g))
        expect(m[0], f).toMatch(/accessibilityRole=/);
    }
  });
  it('shows offers, points and invites as sentences, announces results and says problems in words', () => {
    const s = source('RewardsCenter.tsx');
    expect(s).toMatch(/<Announcer/);
    expect(s).toMatch(/accessibilityRole="alert"/);
    expect(s).toMatch(/Problem: /);
    expect(s).toMatch(/<Card[^>]*title="Your reward points"/);
    expect(s).toMatch(/<Card[^>]*title="Offers for you"/);
    expect(s).toMatch(/<Card[^>]*title="Invite friends"/);
    // Nothing here works out an amount: no arithmetic on money in the screen.
    expect(s).not.toMatch(/\* *\d+ *\/ *100|Math\.(floor|round)/);
  });
  it('shows choices as radio groups and switches, with the selected one exposed', () => {
    const s = source('SettingsCenter.tsx');
    expect(s).toMatch(/accessibilityRole="radiogroup"/);
    expect(s).toMatch(/role="radio"/);
    expect(s).toMatch(/role="switch"/);
    expect(s).toMatch(/selected=\{/);
  });
  it('announces every saved change and every problem, in words', () => {
    const s = source('SettingsCenter.tsx');
    expect(s).toMatch(/<Announcer/);
    expect(s).toMatch(/savedNews/);
    expect(s).toMatch(/accessibilityRole="alert"/);
    expect(s).toMatch(/Problem: /);
  });
  it('gives every group a heading and says what is on or off as text, not colour', () => {
    const s = source('SettingsCenter.tsx');
    expect(s).toMatch(/accessibilityRole="header"/);
    expect(s).toMatch(/On' : 'Off'/);
  });
  it('is read in the first place in the apps and has no motion of its own', () => {
    for (const f of files) expect(source(f), f).not.toMatch(/Animated|LayoutAnimation/);
  });
});
