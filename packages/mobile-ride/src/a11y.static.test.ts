import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural accessibility checks over EVERY mobile source file (both apps and the shared packages).
 * They cannot tell you how TalkBack or VoiceOver sounds, but they catch the mistakes that make a
 * control unreachable or unnamed for a screen reader before anyone has to listen:
 *  - a Pressable with no role (a screen reader would call it "text"),
 *  - a TextInput with no accessible name (a placeholder disappears once typing starts),
 *  - an Image that is neither described nor marked decorative,
 *  - a Text or View with onPress (not focusable by keyboard or switch: use a Pressable),
 *  - a Pressable that names itself with an icon or nothing (it must carry a label or visible text).
 */
const ROOT = join(__dirname, '..', '..', '..');
const DIRS = [
  'apps/passenger/src',
  'apps/driver/src',
  'packages/mobile-ride/src',
  'packages/mobile-location/src',
  'packages/mobile-auth/src',
];

function files(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : files(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

/** Each opening tag of `name`, with its attribute text (attributes may span lines and contain braces). */
function tags(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}(?=[\\s>/])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

const all = DIRS.flatMap((d) => files(join(ROOT, d)));
const where = (f: string) => relative(ROOT, f).split('\\').join('/');

describe('mobile accessibility (static)', () => {
  it('finds the source it is checking, and the controls in it (so a broken scan cannot pass)', () => {
    expect(all.length).toBeGreaterThan(30);
    const count = (name: string) =>
      all.reduce((n, f) => n + tags(readFileSync(f, 'utf8'), name).length, 0);
    expect(count('Pressable')).toBeGreaterThan(10);
    expect(count('TextInput')).toBeGreaterThan(5);
    expect(count('Image')).toBeGreaterThan(0);
  });

  it('gives every Pressable a role', () => {
    const bad: string[] = [];
    for (const f of all) {
      for (const t of tags(readFileSync(f, 'utf8'), 'Pressable')) {
        if (!/accessibilityRole=/.test(t) && !/\{\.\.\.[a-zA-Z]+\}/.test(t))
          bad.push(`${where(f)}: ${t.slice(0, 80).replace(/\s+/g, ' ')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives every Pressable a name a screen reader can speak', () => {
    const bad: string[] = [];
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      // a Pressable is named by accessibilityLabel, or by visible text inside it (checked in its body)
      const re = /<Pressable(?=[\s>/])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const close = src.indexOf('</Pressable>', m.index);
        const block = src.slice(m.index, close < 0 ? m.index + 600 : close);
        if (!/accessibilityLabel=/.test(block) && !/<Text[\s>]/.test(block))
          bad.push(
            `${where(f)}: unnamed Pressable near "${block.slice(0, 60).replace(/\s+/g, ' ')}"`,
          );
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives every TextInput an accessible name', () => {
    const bad: string[] = [];
    for (const f of all) {
      for (const t of tags(readFileSync(f, 'utf8'), 'TextInput')) {
        if (!/accessibilityLabel=|accessibilityLabelledBy=/.test(t))
          bad.push(`${where(f)}: ${t.slice(0, 80).replace(/\s+/g, ' ')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('describes every Image, or marks it decorative', () => {
    const bad: string[] = [];
    for (const f of all) {
      for (const t of tags(readFileSync(f, 'utf8'), 'Image')) {
        if (
          !/accessibilityLabel=|accessible=\{false\}|accessibilityElementsHidden|importantForAccessibility="no/.test(
            t,
          )
        )
          bad.push(`${where(f)}: ${t.slice(0, 80).replace(/\s+/g, ' ')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('never puts onPress on something a keyboard or switch cannot focus', () => {
    const bad: string[] = [];
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      for (const name of ['Text', 'View']) {
        for (const t of tags(src, name))
          if (/\bonPress=/.test(t)) bad.push(`${where(f)}: <${name} onPress>`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps announcements in live regions, not in transient toasts', () => {
    const bad: string[] = [];
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      if (/ToastAndroid\./.test(src))
        bad.push(`${where(f)}: ToastAndroid disappears before a screen reader reads it`);
    }
    expect(bad).toEqual([]);
  });
});
