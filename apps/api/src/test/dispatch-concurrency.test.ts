import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { offerNext } from '../modules/dispatch/dispatch.service';
import { api, onboardUser } from './helpers';
import { PATAN, THAMEL, auth, forceDriverOnline } from './rides';

describe('dispatch under concurrency', () => {
  it('never places more than one open offer on a ride, however many dispatch runs happen at once', async () => {
    const drivers = [await onboardUser('DRIVER'), await onboardUser('DRIVER'), await onboardUser('DRIVER')];
    for (const d of drivers) await forceDriverOnline(d.user.id as string);
    const passenger = await onboardUser('PASSENGER');
    const req = await api.post('/api/v1/trips/request').set(auth(passenger.accessToken)).send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR' });
    expect(req.status).toBe(201);
    const tripId = req.body.data.id as string;
    // the first offer goes away (declined), leaving the ride with no open offer: the moment the old check-then-offer code raced
    await pool.query(`UPDATE trip_offers SET status = 'DECLINED', responded_at = now() WHERE trip_id = $1 AND status = 'OFFERED'`, [tripId]);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => offerNext(tripId)));
    expect(outcomes.every((o) => o === 'offered')).toBe(true);
    const open = await pool.query(`SELECT count(*)::int AS n FROM trip_offers WHERE trip_id = $1 AND status = 'OFFERED'`, [tripId]);
    expect(open.rows[0].n).toBe(1);
    const total = await pool.query('SELECT count(*)::int AS n FROM trip_offers WHERE trip_id = $1', [tripId]);
    expect(total.rows[0].n).toBe(2); // the declined one and the one new offer: no offers were burned by the race
  });

  it('refuses a second open offer on a ride at the database', async () => {
    const [a, b] = [await onboardUser('DRIVER'), await onboardUser('DRIVER')];
    const passenger = await onboardUser('PASSENGER');
    for (const d of [a, b]) await forceDriverOnline(d.user.id as string);
    const req = await api.post('/api/v1/trips/request').set(auth(passenger.accessToken)).send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR' });
    const tripId = req.body.data.id as string;
    const free = (await pool.query(`SELECT d.id FROM users d WHERE d.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM trip_offers o WHERE o.driver_id = d.id AND o.status = 'OFFERED')`, [[a.user.id, b.user.id]])).rows[0]?.id as string;
    await expect(pool.query(`INSERT INTO trip_offers (trip_id, driver_id, pickup_distance_meters, expires_at) VALUES ($1, $2, 100, now() + interval '1 minute')`, [tripId, free])).rejects.toMatchObject({ code: '23505' });
  });
});
