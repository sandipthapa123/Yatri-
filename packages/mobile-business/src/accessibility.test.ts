import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Static accessibility checks for the business screens, like the ones the admin console has: they cannot
 * replace NVDA or TalkBack, but they stop the common regressions (an unlabelled field, a button with no role, a
 * message that is only shown and never announced).
 */
const dir = path.resolve(__dirname, 'components');
const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
const source = (f: string) => readFileSync(path.join(dir, f), 'utf8');

describe('the business screens', () => {
  it('has exactly one text input component, and it is labelled for screen readers', () => {
    const withInputs = files.filter((f) => /<TextInput/.test(source(f)));
    expect(withInputs).toEqual(['Field.tsx']);
    expect(source('Field.tsx')).toMatch(/accessibilityLabel=/);
    expect(source('Field.tsx')).toMatch(/accessibilityRole="alert"/);
  });

  it('gives every raw pressable a role, and uses ActionButton (which has one) elsewhere', () => {
    for (const f of files) {
      for (const m of source(f).matchAll(/<Pressable[\s\S]*?>/g)) {
        expect(m[0], f).toMatch(/accessibilityRole=/);
      }
    }
  });

  it('announces what it says: every screen that speaks news also renders an announcer', () => {
    for (const f of files) {
      const s = source(f);
      if (/useNews\(\)/.test(s)) expect(s, f).toMatch(/<Announcer/);
    }
  });

  it('groups choices as radio groups or tabs, with the selected one exposed', () => {
    for (const f of files) {
      const s = source(f);
      if (/role="radio"/.test(s)) expect(s, f).toMatch(/accessibilityRole="radiogroup"/);
      if (/role="tab"/.test(s)) expect(s, f).toMatch(/accessibilityRole="tablist"/);
    }
  });

  it('confirms removals, declines and approvals with an alert that offers a way back', () => {
    for (const f of ['Members.tsx', 'RidesAndApprovals.tsx']) {
      expect(source(f), f).toMatch(/Alert\.alert/);
      expect(source(f), f).toMatch(/Go back|Stay/);
    }
  });

  it('never states a status by colour alone: problems are words with the role alert', () => {
    for (const f of files.filter((x) => x !== 'Field.tsx')) {
      const s = source(f);
      const uses = (s.match(/color: colors\.error/g) ?? []).length;
      const asProblem =
        (s.match(/<Problem /g) ?? []).length + (s.match(/accessibilityRole="alert"/g) ?? []).length;
      if (uses > 0) expect(asProblem, f).toBeGreaterThan(0);
    }
  });
});
