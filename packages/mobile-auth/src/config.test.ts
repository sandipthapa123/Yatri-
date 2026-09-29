import { describe, expect, it } from 'vitest';

import { API_BASE_URL, resolveMediaUrl } from './config';

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
