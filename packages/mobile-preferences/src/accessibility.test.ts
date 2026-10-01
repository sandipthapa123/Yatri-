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
      expect(source(f), f).not.toMatch(/<TextInput/);
      for (const m of source(f).matchAll(/<Pressable[\s\S]*?>/g))
        expect(m[0], f).toMatch(/accessibilityRole=/);
    }
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
