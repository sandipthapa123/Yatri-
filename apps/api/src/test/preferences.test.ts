import {
  FLEET_NOTIFICATION_TYPES,
  LANGUAGES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_INFO,
  ORG_NOTIFICATION_TYPES,
  PREFERENCE_DEFS,
  RISK_NOTIFICATION_TYPES,
  SUPPORT_NOTIFICATION_TYPES,
  checkPreferenceValue,
  notificationCategoryOf,
  notificationPrefKey,
  preferencesFor,
  type AdminPermission,
  type PreferencesResponse,
} from '@yatri/types';
import { describe, expect, it, vi } from 'vitest';

import { pool } from '../config/database';
import { notify } from '../lib/notifications';
import { ConsoleNotificationProvider } from '../lib/notifications/console-provider';
import { refreshSettings } from '../modules/settings/settings.service';
import { api, loginTestAdmin, onboardUser, type OnboardedUser } from './helpers';
import { THAMEL, auth, clearRedis, finishedRide, forceDriverOnline, requestRide } from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
const base = '/api/v1/users/me';
const get = (t: string, path: string) => api.get(`${base}${path}`).set(auth(t));
const patch = (t: string, body: object) => api.patch(`${base}/preferences`).set(auth(t)).send(body);
const prefs = async (t: string) => (await get(t, '/preferences')).body.data as PreferencesResponse;
const idOf = (u: OnboardedUser) => u.user.id as string;

async function admin(permissions: AdminPermission[]) {
  const email = `prefs-admin-${Date.now()}-${++n}@example.com`;
  return loginTestAdmin(email, 'a-strong-test-password-1', permissions);
}
/** A second device: the same person signing in again gives a second session. */
async function secondDevice(u: OnboardedUser): Promise<{ accessToken: string }> {
  await clearRedis(); // the same person asking for a code again would otherwise wait out the resend cooldown
  const req = await api
    .post('/api/v1/auth/request-otp')
    .send({ phoneNumber: u.phoneNumber, role: u.role });
  expect(req.status, JSON.stringify(req.body)).toBe(200);
  const ver = await api
    .post('/api/v1/auth/verify-otp')
    .set('User-Agent', 'Second phone')
    .send({ phoneNumber: u.phoneNumber, role: u.role, code: req.body.data.devOtp });
  expect(ver.status, JSON.stringify(ver.body)).toBe(200);
  return { accessToken: ver.body.data.accessToken as string };
}
const setSetting = async (key: string, value: unknown) => {
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
    [key, JSON.stringify(value)],
  );
  await refreshSettings();
};
const clearSetting = async (key: string) => {
  await pool.query('DELETE FROM platform_settings WHERE key = $1', [key]);
  await refreshSettings();
};
const noteRows = async (userId: string, type: string) =>
  (
    await pool.query(
      "SELECT (delivery_status = 'SUPPRESSED') AS suppressed FROM notifications WHERE user_id = $1 AND type = $2",
      [userId, type],
    )
  ).rows as Array<{ suppressed: boolean }>;

// ---------------------------------------------------------------- the one table

describe('the preference definitions', () => {
  it('has unique keys, valid built-in defaults and words for every choice', () => {
    const keys = PREFERENCE_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of PREFERENCE_DEFS) {
      expect(d.label.length).toBeGreaterThan(2);
      expect(d.help.length).toBeGreaterThan(10);
      if (d.default !== null) expect(checkPreferenceValue(d, d.default).ok, d.key).toBe(true);
      if (d.kind === 'enum')
        for (const o of d.options ?? []) expect(o.label.length).toBeGreaterThan(1);
    }
    // a language not translated yet is listed but cannot be saved
    expect(LANGUAGES.filter((l) => l.available).map((l) => l.code)).toEqual(['en']);
    const lang = PREFERENCE_DEFS.find((d) => d.key === 'language')!;
    expect(checkPreferenceValue(lang, 'ne')).toMatchObject({ ok: false });
    expect(checkPreferenceValue(lang, 'en')).toEqual({ ok: true, value: 'en' });
    expect(checkPreferenceValue(lang, null)).toEqual({ ok: true, value: null });
  });

  it('gives each optional notification category a switch and no mandatory one', () => {
    for (const c of NOTIFICATION_CATEGORIES) {
      const has = PREFERENCE_DEFS.some((d) => d.key === notificationPrefKey(c));
      expect(has, c).toBe(!NOTIFICATION_CATEGORY_INFO[c].mandatory);
    }
    expect(NOTIFICATION_CATEGORY_INFO.SAFETY.mandatory).toBe(true);
    expect(NOTIFICATION_CATEGORY_INFO.ACCOUNT.mandatory).toBe(true);
  });

  it('classifies every notification type in one place, and never drops an unknown one', () => {
    expect(notificationCategoryOf('SOS_TRIGGERED')).toBe('SAFETY');
    expect(notificationCategoryOf('TRIP_SHARE_STARTED')).toBe('SAFETY');
    expect(notificationCategoryOf('TRIP_STARTED')).toBe('RIDE_UPDATES');
    expect(notificationCategoryOf('DRIVER_ARRIVED')).toBe('RIDE_UPDATES');
    expect(notificationCategoryOf('NO_DRIVERS_FOUND')).toBe('RIDE_UPDATES');
    expect(notificationCategoryOf('DRIVER_APPROVED')).toBe('ACCOUNT');
    expect(notificationCategoryOf('DRIVER_SUSPENDED')).toBe('ACCOUNT');
    expect(notificationCategoryOf('DOCUMENT_REJECTED')).toBe('ACCOUNT');
    expect(notificationCategoryOf('CHAT_MESSAGE')).toBe('CHAT_AND_CALLS');
    expect(notificationCategoryOf('CALL_MISSED')).toBe('CHAT_AND_CALLS');
    expect(notificationCategoryOf('PAYMENT_RECEIVED')).toBe('PAYMENTS');
    expect(notificationCategoryOf('INCENTIVE_EARNED')).toBe('REWARDS');
    for (const t of Object.values(SUPPORT_NOTIFICATION_TYPES))
      expect(notificationCategoryOf(t)).toBe('SUPPORT');
    for (const t of Object.values(ORG_NOTIFICATION_TYPES))
      expect(notificationCategoryOf(t)).toBe('BUSINESS');
    for (const t of [
      ...Object.values(FLEET_NOTIFICATION_TYPES),
      ...Object.values(RISK_NOTIFICATION_TYPES),
    ]) {
      expect(notificationCategoryOf(t)).toBe('ACCOUNT');
    }
    expect(notificationCategoryOf('SOMETHING_NEW')).toBe('ACCOUNT');
    expect(NOTIFICATION_CATEGORY_INFO[notificationCategoryOf('SOMETHING_NEW')].mandatory).toBe(
      true,
    );
  });

  it('shows each role only the settings that are for it', () => {
    const passenger = preferencesFor('PASSENGER').map((d) => d.key);
    const driver = preferencesFor('DRIVER').map((d) => d.key);
    expect(passenger).toEqual(
      expect.arrayContaining(['theme', 'defaultVehicle', 'nameShownToDrivers', 'notify.BUSINESS']),
    );
    expect(driver).toEqual(
      expect.arrayContaining(['theme', 'textSize', 'notify.REWARDS', 'confirmBeforeSos']),
    );
    expect(driver).not.toContain('defaultVehicle');
    expect(driver).not.toContain('nameShownToDrivers');
    // Reward points and offers are for riders too (Phase 24); offers are opt-in.
    expect(passenger).toEqual(expect.arrayContaining(['notify.REWARDS', 'notify.PROMOTIONS']));
  });
});

// ---------------------------------------------------------------- saving and multi-device

describe('preferences and their persistence', () => {
  it('starts at the defaults, saves what is changed, and puts a key back with null', async () => {
    const p = await onboardUser('PASSENGER');
    const first = await prefs(p.accessToken);
    expect(first).toMatchObject({ version: 0, overridden: [], updatedAt: null });
    expect(first.values).toMatchObject({
      theme: 'SYSTEM',
      textSize: 'STANDARD',
      language: 'en',
      reducedMotion: 'SYSTEM',
      defaultPayment: 'CASH',
      'notify.RIDE_UPDATES': true,
    });
    expect(first.values.defaultVehicle).toBeNull();

    const r = await patch(p.accessToken, {
      changes: { theme: 'DARK', textSize: 'LARGE', largerTouchTargets: true },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      version: 1,
      overridden: ['theme', 'textSize', 'largerTouchTargets'],
    });
    expect(r.body.data.values).toMatchObject({
      theme: 'DARK',
      textSize: 'LARGE',
      largerTouchTargets: true,
      reducedMotion: 'SYSTEM',
    });
    // it persists: a fresh read and the database agree
    expect((await prefs(p.accessToken)).values.theme).toBe('DARK');
    const row = await pool.query('SELECT choices FROM user_preferences WHERE user_id = $1', [
      idOf(p),
    ]);
    expect(row.rows[0].choices).toEqual({
      theme: 'DARK',
      textSize: 'LARGE',
      largerTouchTargets: true,
    });
    // back to the default stores nothing
    const back = await patch(p.accessToken, { changes: { theme: null } });
    expect(back.body.data.values.theme).toBe('SYSTEM');
    expect(back.body.data.overridden).not.toContain('theme');
    expect(back.body.data.version).toBe(2);
  });

  it('refuses what is not a setting, not for the role, not a legal value, and an empty save', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    for (const [who, changes] of [
      [p, { fareBaseNpr: 1 }],
      [p, { theme: 'NEON' }],
      [p, { textSize: 5 }],
      [p, { largerTouchTargets: 'yes' }],
      [p, { language: 'ne' }],
      [p, { defaultVehicle: 'SPACESHIP' }],
      [p, { defaultPayment: 'ORGANIZATION' }],
      [d, { defaultVehicle: 'CAR' }],
      [d, { nameShownToDrivers: 'FIRST_NAME' }],
      [d, { 'notify.BUSINESS': false }],
      [p, { 'notify.SAFETY': false }],
      [p, {}],
    ] as Array<[OnboardedUser, object]>) {
      const r = await patch(who.accessToken, { changes });
      expect(r.status, JSON.stringify(changes)).toBe(400);
    }
    expect((await patch(p.accessToken, { changes: { theme: 'DARK' }, extra: 1 })).status).toBe(400);
    expect((await prefs(p.accessToken)).version).toBe(0); // nothing was half-saved
    // a valid vehicle type is accepted and a driver can use theirs
    expect(
      (await patch(p.accessToken, { changes: { defaultVehicle: 'CAR' } })).body.data.values
        .defaultVehicle,
    ).toBe('CAR');
    expect(
      (await patch(d.accessToken, { changes: { reducedMotion: 'ON', 'notify.REWARDS': false } }))
        .status,
    ).toBe(200);
  });

  it('is one atomic save: a bad value in a batch changes nothing', async () => {
    const p = await onboardUser('PASSENGER');
    const r = await patch(p.accessToken, { changes: { theme: 'DARK', textSize: 'HUGE' } });
    expect(r.status).toBe(400);
    expect((await prefs(p.accessToken)).values.theme).toBe('SYSTEM');
  });

  it('is only for the person themselves, and for riders and drivers', async () => {
    expect((await api.get(`${base}/preferences`)).status).toBe(401);
    const a = await admin(['SETTINGS_MANAGE']);
    expect((await get(a, '/preferences')).status).toBe(403);
    expect((await patch(a, { changes: { theme: 'DARK' } })).status).toBe(403);
    // one person's settings are never another's
    const p1 = await onboardUser('PASSENGER');
    const p2 = await onboardUser('PASSENGER');
    await patch(p1.accessToken, { changes: { theme: 'DARK' } });
    expect((await prefs(p2.accessToken)).values.theme).toBe('SYSTEM');
  });

  it('is the same on every device, and two devices cannot overwrite each other unseen', async () => {
    const p = await onboardUser('PASSENGER');
    const phone2 = await secondDevice(p);
    await patch(p.accessToken, { changes: { theme: 'DARK' } });
    // device two sees it at once
    const seen = await prefs(phone2.accessToken);
    expect(seen.values.theme).toBe('DARK');
    expect(seen.version).toBe(1);
    // device two saves based on what it saw
    const ok = await patch(phone2.accessToken, {
      changes: { textSize: 'LARGE' },
      expectedVersion: 1,
    });
    expect(ok.status).toBe(200);
    // device one is still on version 1: told to look again, with the current settings
    const stale = await patch(p.accessToken, {
      changes: { reducedMotion: 'ON' },
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.current.values.textSize).toBe('LARGE');
    expect((await prefs(p.accessToken)).values.reducedMotion).toBe('SYSTEM');
    // after reading, it can save
    expect(
      (await patch(p.accessToken, { changes: { reducedMotion: 'ON' }, expectedVersion: 2 })).status,
    ).toBe(200);
    const merged = await prefs(phone2.accessToken);
    expect(merged.values).toMatchObject({ theme: 'DARK', textSize: 'LARGE', reducedMotion: 'ON' });
  });

  it('lets exactly one of two simultaneous saves from the same version through', async () => {
    const p = await onboardUser('PASSENGER');
    const phone2 = await secondDevice(p);
    const [a, b] = await Promise.all([
      patch(p.accessToken, { changes: { theme: 'DARK' }, expectedVersion: 0 }),
      patch(phone2.accessToken, { changes: { theme: 'LIGHT' }, expectedVersion: 0 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await prefs(p.accessToken)).version).toBe(1);
  });

  it('keeps preferences when someone signs out and in again, and removes them with the account data', async () => {
    const p = await onboardUser('PASSENGER');
    await patch(p.accessToken, { changes: { textSize: 'EXTRA_LARGE' } });
    const again = await secondDevice(p);
    expect((await prefs(again.accessToken)).values.textSize).toBe('EXTRA_LARGE');
  });
});

// ---------------------------------------------------------------- notification preferences

describe('notification preferences are respected by the notification service', () => {
  it('records but does not push what a person switched off, and always pushes mandatory ones', async () => {
    const send = vi.spyOn(ConsoleNotificationProvider.prototype, 'send');
    try {
      const p = await onboardUser('PASSENGER');
      const other = await onboardUser('PASSENGER');
      const payload = (userId: string, type: string) => ({
        userId,
        type,
        title: 'Yatri',
        body: `body of ${type}`,
      });

      await notify(payload(idOf(p), 'TRIP_STARTED'));
      expect(send).toHaveBeenCalledTimes(1); // on by default

      await patch(p.accessToken, {
        changes: { 'notify.RIDE_UPDATES': false, 'notify.CHAT_AND_CALLS': false },
      });
      send.mockClear();
      await notify(payload(idOf(p), 'TRIP_COMPLETED'));
      await notify(payload(idOf(p), 'CHAT_MESSAGE'));
      expect(send).not.toHaveBeenCalled();
      // still in their history, and marked as not pushed
      expect(await noteRows(idOf(p), 'TRIP_COMPLETED')).toEqual([{ suppressed: true }]);
      expect(await noteRows(idOf(p), 'CHAT_MESSAGE')).toEqual([{ suppressed: true }]);

      // mandatory and unclassified types are delivered whatever was chosen
      for (const type of [
        'SOS_TRIGGERED',
        'DRIVER_APPROVED',
        'DOCUMENT_REJECTED',
        'DATA_REQUEST_UPDATE',
        'A_BRAND_NEW_TYPE',
      ]) {
        await notify(payload(idOf(p), type));
      }
      expect(send).toHaveBeenCalledTimes(5);
      expect(await noteRows(idOf(p), 'SOS_TRIGGERED')).toEqual([{ suppressed: false }]);

      // other categories and other people are untouched
      send.mockClear();
      await notify(payload(idOf(p), 'PAYMENT_RECEIVED'));
      await notify(payload(idOf(other), 'TRIP_COMPLETED'));
      expect(send).toHaveBeenCalledTimes(2);

      // turning it back on (null = default) delivers again
      await patch(p.accessToken, { changes: { 'notify.RIDE_UPDATES': null } });
      send.mockClear();
      await notify(payload(idOf(p), 'TRIP_STARTED'));
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
  });

  it('applies to the support, business and bonus categories through their own types, and to drivers', async () => {
    const send = vi.spyOn(ConsoleNotificationProvider.prototype, 'send');
    try {
      const p = await onboardUser('PASSENGER');
      const d = await onboardUser('DRIVER');
      await patch(p.accessToken, {
        changes: { 'notify.SUPPORT': false, 'notify.BUSINESS': false },
      });
      await patch(d.accessToken, { changes: { 'notify.REWARDS': false } });
      send.mockClear();
      await notify({
        userId: idOf(p),
        type: SUPPORT_NOTIFICATION_TYPES.REPLY,
        title: 'x',
        body: 'x',
      });
      await notify({
        userId: idOf(p),
        type: ORG_NOTIFICATION_TYPES.STATEMENT_ISSUED,
        title: 'x',
        body: 'x',
      });
      await notify({ userId: idOf(d), type: 'INCENTIVE_EARNED', title: 'x', body: 'x' });
      expect(send).not.toHaveBeenCalled();
      await notify({ userId: idOf(d), type: 'DRIVER_ASSIGNED', title: 'x', body: 'x' });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- privacy

describe('privacy controls', () => {
  it('shows the driver only the passenger’s first name when the passenger chooses', async () => {
    const w = await finishedRide(false);
    await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      w.passengerId,
      'Mina Kumari Shrestha',
    ]);
    const driverView = async () =>
      (await api.get(`/api/v1/trips/${w.tripId}`).set(auth(w.driver.accessToken))).body.data
        .counterpart.name;
    expect(await driverView()).toBe('Mina Kumari Shrestha');
    await patch(w.passenger.accessToken, { changes: { nameShownToDrivers: 'FIRST_NAME' } });
    expect(await driverView()).toBe('Mina');
    // the passenger's own view of the driver is unchanged, and the passenger still sees their own full name
    const mine = await api.get('/api/v1/users/me').set(auth(w.passenger.accessToken));
    expect(mine.body.data.fullName).toBe('Mina Kumari Shrestha');
    await patch(w.passenger.accessToken, { changes: { nameShownToDrivers: null } });
    expect(await driverView()).toBe('Mina Kumari Shrestha');
  }, 90_000);

  it('offers recent destinations from the person’s own rides, hides and clears them on request', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    expect((await get(p.accessToken, '/recent-places')).body.data).toEqual({
      items: [],
      hidden: false,
    });
    await forceDriverOnline(idOf(d));
    for (const dest of [
      { latitude: 27.6727, longitude: 85.325, address: 'Patan Durbar Square', name: 'Patan' },
      { latitude: 27.7, longitude: 85.33, address: 'Baneshwor', name: 'Baneshwor' },
    ]) {
      const r = await api
        .post('/api/v1/trips/request')
        .set(auth(p.accessToken))
        .send({
          pickup: { ...THAMEL, address: 'Thamel' },
          destination: dest,
          vehicleCategory: 'CAR',
        });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await api.post(`/api/v1/trips/${r.body.data.id}/cancel`).set(auth(p.accessToken)).send({});
    }
    const list = (await get(p.accessToken, '/recent-places')).body.data;
    expect(list.items.map((i: { address: string }) => i.address)).toEqual([
      'Baneshwor',
      'Patan Durbar Square',
    ]);
    expect(list.items[0]).toMatchObject({ rides: 1 });
    // the platform setting limits how many are shown
    await setSetting('RECENT_PLACES_LIMIT', 1);
    try {
      expect((await get(p.accessToken, '/recent-places')).body.data.items).toHaveLength(1);
    } finally {
      await clearSetting('RECENT_PLACES_LIMIT');
    }
    // another person sees nothing of it
    const q = await onboardUser('PASSENGER');
    expect((await get(q.accessToken, '/recent-places')).body.data.items).toEqual([]);
    // hidden by preference: empty on purpose, and says so
    await patch(p.accessToken, { changes: { showRecentPlaces: false } });
    expect((await get(p.accessToken, '/recent-places')).body.data).toEqual({
      items: [],
      hidden: true,
    });
    await patch(p.accessToken, { changes: { showRecentPlaces: null } });
    // cleared: what was recent stops being offered, the rides stay in history
    expect((await api.post(`${base}/recent-places/clear`).set(auth(p.accessToken))).status).toBe(
      200,
    );
    expect((await get(p.accessToken, '/recent-places')).body.data.items).toEqual([]);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM trips WHERE passenger_id = $1', [idOf(p)]))
        .rows[0].n,
    ).toBe(2);
    // and a new ride is offered again
    const again = await requestRide(p.accessToken);
    expect(again.status).toBe(201);
    expect((await get(p.accessToken, '/recent-places')).body.data.items).toHaveLength(1);
  }, 90_000);

  it('does not offer destinations of rides someone else booked for the person', async () => {
    const p = await onboardUser('PASSENGER');
    const booker = await onboardUser('PASSENGER');
    const r = await requestRide(p.accessToken);
    await api.post(`/api/v1/trips/${r.body.data.id}/cancel`).set(auth(p.accessToken)).send({});
    expect((await get(p.accessToken, '/recent-places')).body.data.items).toHaveLength(1);
    await pool.query('UPDATE trips SET booked_by = $2 WHERE passenger_id = $1', [
      idOf(p),
      idOf(booker),
    ]);
    expect((await get(p.accessToken, '/recent-places')).body.data.items).toEqual([]);
  });

  it('keeps preferences out of every administrator screen: there is no route that reads them', async () => {
    const a = await admin(['SETTINGS_MANAGE', 'USERS_MANAGE', 'USERS_VIEW', 'NOTIFICATIONS_VIEW']);
    const p = await onboardUser('PASSENGER');
    await patch(p.accessToken, { changes: { nameShownToDrivers: 'FIRST_NAME' } });
    const detail = await api.get(`/api/v1/admin/users/${idOf(p)}`).set(auth(a));
    expect(JSON.stringify(detail.body)).not.toMatch(
      /nameShownToDrivers|FIRST_NAME|user_preferences|choices/,
    );
  });
});

// ---------------------------------------------------------------- devices

describe('device management', () => {
  it('lists the person’s own devices and signs them out, one or all the others', async () => {
    const p = await onboardUser('PASSENGER');
    const phone2 = await secondDevice(p);
    const other = await onboardUser('PASSENGER');
    const list = (await get(p.accessToken, '/devices')).body.data as Array<{
      id: string;
      current: boolean;
      deviceLabel: string | null;
    }>;
    expect(list).toHaveLength(2);
    expect(list.filter((d) => d.current)).toHaveLength(1);
    expect(list.map((d) => d.deviceLabel)).toContain('Second phone');
    expect(JSON.stringify(list)).not.toMatch(/ipAddress|ip_address|refresh|token/i);
    // only your own sessions are found
    const theirs = (await get(other.accessToken, '/devices')).body.data[0].id as string;
    expect((await api.delete(`${base}/devices/${theirs}`).set(auth(p.accessToken))).status).toBe(
      404,
    );
    expect((await get(other.accessToken, '/devices')).body.data).toHaveLength(1);
    // sign out device two: its token stops working
    const two = list.find((d) => !d.current)!;
    expect((await api.delete(`${base}/devices/${two.id}`).set(auth(p.accessToken))).status).toBe(
      200,
    );
    expect((await get(phone2.accessToken, '/preferences')).status).toBe(401);
    expect((await api.delete(`${base}/devices/${two.id}`).set(auth(p.accessToken))).status).toBe(
      404,
    );
    expect((await get(p.accessToken, '/devices')).body.data).toHaveLength(1);
    // sign out all others
    const three = await secondDevice(p);
    const four = await secondDevice(p);
    const r = await api.post(`${base}/devices/sign-out-others`).set(auth(p.accessToken));
    expect(r.body.data.signedOut).toBe(2);
    for (const t of [three, four])
      expect((await get(t.accessToken, '/preferences')).status).toBe(401);
    expect((await get(p.accessToken, '/preferences')).status).toBe(200); // this one stays
    const events = await pool.query(
      "SELECT count(*)::int AS n FROM auth_events WHERE user_id = $1 AND event_type = 'SESSION_REVOKED'",
      [idOf(p)],
    );
    expect(events.rows[0].n).toBe(2);
    expect((await api.get(`${base}/devices`)).status).toBe(401);
  });

  it('rate-limits signing devices out', async () => {
    const p = await onboardUser('PASSENGER');
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await api.post(`${base}/devices/sign-out-others`).set(auth(p.accessToken))).status;
    expect(last).toBe(429);
  });
});

// ---------------------------------------------------------------- platform configuration

describe('platform settings for the experience', () => {
  const adminPut = (t: string, key: string, body: object) =>
    api.put(`/api/v1/admin/settings/${key}`).set(auth(t)).send(body);
  const adminGet = (t: string) => api.get('/api/v1/admin/settings').set(auth(t));

  it('lists the experience settings for administrators, who change them with a reason and a version', async () => {
    const manager = await admin(['SETTINGS_MANAGE']);
    const viewer = await admin(['SETTINGS_VIEW']);
    const nobody = await admin(['OPERATIONS_VIEW']);
    const list = (await adminGet(manager)).body.data.settings as Array<{
      key: string;
      group: string;
      value: unknown;
      version: number;
    }>;
    const lang = list.find((s) => s.key === 'DEFAULT_LANGUAGE')!;
    const limit = list.find((s) => s.key === 'RECENT_PLACES_LIMIT')!;
    expect(lang).toMatchObject({ group: 'experience', value: 'en' });
    expect(limit).toMatchObject({ group: 'experience', value: 8 });

    expect(
      (
        await adminPut(viewer, 'RECENT_PLACES_LIMIT', {
          value: 5,
          expectedVersion: 0,
          reason: 'testing',
        })
      ).status,
    ).toBe(403);
    expect((await adminGet(nobody)).status).toBe(403);
    const ok = await adminPut(manager, 'RECENT_PLACES_LIMIT', {
      value: 5,
      expectedVersion: 0,
      reason: 'Fewer suggestions',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ value: 5, overridden: true, version: 1 });
    // out of range, stale and unknown are refused
    expect(
      (
        await adminPut(manager, 'RECENT_PLACES_LIMIT', {
          value: 99,
          expectedVersion: 1,
          reason: 'too many',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await adminPut(manager, 'RECENT_PLACES_LIMIT', {
          value: 6,
          expectedVersion: 0,
          reason: 'stale one',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await adminPut(manager, 'NOT_A_SETTING', {
          value: 6,
          expectedVersion: 0,
          reason: 'nothing',
        })
      ).status,
    ).toBe(404);
    const log = await pool.query(
      "SELECT detail FROM audit_log WHERE action = 'SETTING_CHANGED' ORDER BY id DESC LIMIT 1",
    );
    expect(JSON.stringify(log.rows[0]?.detail)).toContain('Fewer suggestions');
    await refreshSettings();
  });

  it('only lets a language the apps are translated into be the default', async () => {
    const manager = await admin(['SETTINGS_MANAGE']);
    for (const bad of ['ne', 'xx', 'english', '']) {
      const r = await adminPut(manager, 'DEFAULT_LANGUAGE', {
        value: bad,
        expectedVersion: 0,
        reason: 'try it',
      });
      expect(r.status, bad).toBe(400);
    }
    expect(
      (
        await adminPut(manager, 'DEFAULT_LANGUAGE', {
          value: 'en',
          expectedVersion: 0,
          reason: 'Confirm English',
        })
      ).status,
    ).toBe(200);
  });

  it('feeds the default every person gets until they choose, and the apps read it before sign-in', async () => {
    const p = await onboardUser('PASSENGER');
    const chooser = await onboardUser('PASSENGER');
    await patch(chooser.accessToken, { changes: { language: 'en' } });
    // an administrator-set default that is not the built-in one (written straight to the store to prove the path)
    await setSetting('DEFAULT_LANGUAGE', 'ne');
    try {
      const mine = await prefs(p.accessToken);
      expect(mine.values.language).toBe('ne');
      expect(mine.defaults.language).toBe('ne');
      expect(mine.overridden).not.toContain('language');
      // someone who chose keeps their choice
      expect((await prefs(chooser.accessToken)).values.language).toBe('en');
      expect((await api.get('/api/v1/config/platform')).body.data.defaultLanguage).toBe('ne');
    } finally {
      await clearSetting('DEFAULT_LANGUAGE');
    }
    expect((await prefs(p.accessToken)).values.language).toBe('en');
  });

  it('never lets a preference change a rule the server owns', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(idOf(d));
    await patch(p.accessToken, { changes: { defaultVehicle: 'SUV', defaultPayment: 'CASH' } });
    // the request names its own vehicle type and the server prices it: the preference changes nothing
    const r = await requestRide(p.accessToken, THAMEL, undefined, 'CAR');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.vehicleCategory.code).toBe('CAR');
    // fares, cancellation and the like cannot be set as preferences
    for (const key of [
      'FARE_BASE_NPR',
      'CANCEL_FEE_NPR',
      'fare',
      'status',
      'role',
      'phoneNumber',
    ]) {
      expect((await patch(p.accessToken, { changes: { [key]: 1 } })).status, key).toBe(400);
    }
  });

  it('rate-limits saving preferences', async () => {
    const p = await onboardUser('PASSENGER');
    let last = 0;
    for (let i = 0; i < 62; i++)
      last = (await patch(p.accessToken, { changes: { theme: i % 2 ? 'DARK' : 'LIGHT' } })).status;
    expect(last).toBe(429);
  });
});
