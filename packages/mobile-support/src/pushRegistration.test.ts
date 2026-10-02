import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', () => ({}));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@yatri/mobile-auth', () => ({ authApi: { request: vi.fn() } }));

import { registerPush, type PushDeps } from './pushRegistration';

const deps = (over: Partial<PushDeps> = {}): PushDeps & { sent: Array<[string, string]> } => {
  const sent: Array<[string, string]> = [];
  return {
    sent,
    platform: 'android',
    getPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getToken: async () => 'ExponentPushToken[abcdefghij]',
    send: async (t, p) => {
      sent.push([t, p]);
    },
    ...over,
  };
};

describe('registering a phone for push', () => {
  it('registers the phone once permission is given, and tells the server only its address and platform', async () => {
    const d = deps();
    expect(await registerPush(d)).toBe('registered');
    expect(d.sent).toEqual([['ExponentPushToken[abcdefghij]', 'android']]);
  });

  it('asks for permission only when it has never been asked, and respects a refusal without asking again', async () => {
    const request = vi.fn(async () => 'denied' as const);
    expect(await registerPush(deps({ getPermission: async () => 'undetermined', requestPermission: request }))).toBe('denied');
    expect(request).toHaveBeenCalledTimes(1);
    const again = vi.fn(async () => 'granted' as const);
    expect(await registerPush(deps({ getPermission: async () => 'denied', requestPermission: again }))).toBe('denied');
    expect(again).not.toHaveBeenCalled();
    const asked = deps({ getPermission: async () => 'undetermined', requestPermission: async () => 'granted' });
    expect(await registerPush(asked)).toBe('registered');
  });

  it('sends nothing when the phone has no push address, a web build, or the call fails', async () => {
    const none = deps({ getToken: async () => null });
    expect(await registerPush(none)).toBe('unavailable');
    expect(none.sent).toEqual([]);
    expect(await registerPush(deps({ platform: 'web' }))).toBe('unavailable');
    expect(await registerPush(deps({ getToken: async () => { throw new Error('no project id'); } }))).toBe('unavailable');
    expect(await registerPush(deps({ send: async () => { throw new Error('offline'); } }))).toBe('unavailable'); // tried again next time
  });
});
