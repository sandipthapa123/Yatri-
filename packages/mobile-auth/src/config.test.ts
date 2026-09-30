import { describe, expect, it } from 'vitest';

import { API_BASE_URL, resolveApiBaseUrl, resolveMediaUrl } from './config';

describe('resolveMediaUrl', () => {
  it('turns a path on the API host into a loadable absolute URL, and leaves everything else alone', () => {
    const origin = API_BASE_URL.replace(/\/api\/v\d+\/?$/, '');
    expect(resolveMediaUrl('/api/v1/storage/content?key=a&sig=b')).toBe(
      `${origin}/api/v1/storage/content?key=a&sig=b`,
    );
    expect(resolveMediaUrl('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
    expect(resolveMediaUrl(null)).toBeNull();
    expect(resolveMediaUrl(undefined)).toBeNull();
    expect(resolveMediaUrl('')).toBeNull();
  });
});

describe('resolveApiBaseUrl', () => {
  it('lets development use the local server, or any address it is given', () => {
    expect(resolveApiBaseUrl(undefined, true)).toBe('http://localhost:4000/api/v1');
    expect(resolveApiBaseUrl('', true)).toBe('http://localhost:4000/api/v1');
    expect(resolveApiBaseUrl('http://192.168.1.20:4000/api/v1', true)).toBe(
      'http://192.168.1.20:4000/api/v1',
    );
  });

  it('gives a release build only an https address of a real server', () => {
    expect(resolveApiBaseUrl('https://api.example.org/api/v1', false)).toBe(
      'https://api.example.org/api/v1',
    );
    for (const bad of [
      undefined,
      '',
      '   ',
      'http://api.example.org/api/v1', // cleartext
      'https://localhost:4000/api/v1',
      'https://127.0.0.1/api/v1',
      'https://10.0.2.2/api/v1', // the Android emulator's host machine
      'not a url',
    ]) {
      expect(() => resolveApiBaseUrl(bad, false), String(bad)).toThrow();
    }
  });

  it('never puts the address it rejected into the message (it might carry a credential)', () => {
    try {
      resolveApiBaseUrl('http://user:pw@api.example.org', false);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('pw');
    }
  });
});
