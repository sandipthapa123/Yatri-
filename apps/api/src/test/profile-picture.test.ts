import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { buildSignedPath } from '../lib/storage/signed-url';
import { freshProfilePictureUrl } from '../modules/users/profile-picture';
import { FIXTURES, api, onboardUser } from './helpers';
import { arriveAtPickup, auth, rideWorld } from './rides';

const upload = (token: string) =>
  api
    .post('/api/v1/users/me/profile-picture')
    .set(auth(token))
    .attach('file', FIXTURES.jpeg, { filename: 'me.jpg', contentType: 'image/jpeg' });

/** A link exactly like the ones stored before, but already past its expiry. */
const expiredLinkFor = (storedLink: string) => {
  const p = new URL(storedLink, 'http://x').searchParams;
  const link = buildSignedPath(p.get('key') as string, -60, {
    contentType: p.get('contentType') ?? undefined,
  });
  return link;
};

describe('profile picture links', () => {
  it('re-issues a working link on every read, even when the stored one has expired', async () => {
    const u = await onboardUser('PASSENGER');
    const up = await upload(u.accessToken);
    expect(up.status).toBe(201);
    const first = up.body.data.profilePictureUrl as string;
    expect((await api.get(first)).status).toBe(200);

    // the stored link goes stale (as after the old 30-day lifetime)
    const stale = expiredLinkFor(first);
    expect((await api.get(stale)).status).not.toBe(200);
    await pool.query('UPDATE users SET profile_picture_url = $2 WHERE id = $1', [u.user.id, stale]);

    const me = (await api.get('/api/v1/users/me').set(auth(u.accessToken))).body.data;
    expect(me.profilePictureUrl).not.toBe(stale);
    expect((await api.get(me.profilePictureUrl)).status).toBe(200);
  });

  it('passes through a link that is not ours, and a missing picture, unchanged', async () => {
    expect(await freshProfilePictureUrl(null)).toBeNull();
    expect(await freshProfilePictureUrl('https://cdn.example.com/a.jpg')).toBe(
      'https://cdn.example.com/a.jpg',
    );
    expect(await freshProfilePictureUrl('/api/v1/storage/content?nokey=1')).toBe(
      '/api/v1/storage/content?nokey=1',
    );
  });

  it('gives the passenger a working driver photo on the ride, and the driver none of the passenger', async () => {
    const w = await rideWorld();
    const driverPic = await upload(w.driver.accessToken);
    await pool.query('UPDATE users SET profile_picture_url = $2 WHERE id = $1', [
      w.driverId,
      expiredLinkFor(driverPic.body.data.profilePictureUrl),
    ]);
    await arriveAtPickup(w);

    const seen = (await api.get(`/api/v1/trips/${w.tripId}`).set(auth(w.passenger.accessToken)))
      .body.data.counterpart;
    expect(seen.photoUrl).toMatch(/^\/api\/v1\/storage\/content\?/);
    expect((await api.get(seen.photoUrl)).status).toBe(200);

    const passengerPic = await upload(w.passenger.accessToken);
    expect(passengerPic.status).toBe(201);
    const driverSees = (await api.get(`/api/v1/trips/${w.tripId}`).set(auth(w.driver.accessToken)))
      .body.data.counterpart;
    expect(driverSees.photoUrl).toBeNull();
  });
});
