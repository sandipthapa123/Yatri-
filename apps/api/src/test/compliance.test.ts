import {
  DATA_REQUEST_STATES,
  DATA_REQUEST_TRANSITIONS,
  RETENTION_RECORD_TYPES,
  canDataRequestTransition,
  dataRequestStatesLeadingTo,
  type AdminPermission,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { runRetention } from '../modules/compliance/retention.service';
import { FIXTURES, api, loginTestAdmin, onboardUser, uploadDocument } from './helpers';
import { auth, finishedRide, rideWorld } from './rides';

let n = 0;
async function admin(permissions: AdminPermission[] = ['COMPLIANCE_MANAGE']) {
  const email = `compliance-admin-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1', permissions);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  return { token, id: id as string };
}
const me = (token: string, path: string) => api.get(`/api/v1/compliance${path}`).set(auth(token));
const mePost = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/compliance${path}`).set(auth(token)).send(body);
const adm = (token: string, path: string) =>
  api.get(`/api/v1/admin/compliance${path}`).set(auth(token));
const admPost = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/admin/compliance${path}`).set(auth(token)).send(body);
const admPatch = (token: string, path: string, body: object = {}) =>
  api.patch(`/api/v1/admin/compliance${path}`).set(auth(token)).send(body);

async function resetPolicy() {
  await pool.query(
    "UPDATE compliance_policies SET version = '1', content_url = NULL, title = 'Terms of service' WHERE key = 'TERMS'",
  );
}

describe('policy acceptance', () => {
  it('lists the policies for the role and records acceptance of the current version with a time', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    const pol = (await me(p.accessToken, '/policies')).body.data as Array<{
      key: string;
      accepted: boolean;
      required: boolean;
    }>;
    expect(pol.map((x) => x.key).sort()).toEqual(['LOCATION_CONSENT', 'PRIVACY', 'TERMS']); // no driver agreement
    expect(pol.every((x) => !x.accepted)).toBe(true);
    const driverPol = (await me(d.accessToken, '/policies')).body.data as Array<{ key: string }>;
    expect(driverPol.map((x) => x.key)).toContain('DRIVER_AGREEMENT');

    const ok = await mePost(p.accessToken, '/accept', { key: 'TERMS', version: '1' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ policyKey: 'TERMS', policyVersion: '1', source: 'APP' });
    expect(new Date(ok.body.data.acceptedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // accepting again is harmless, one record
    expect((await mePost(p.accessToken, '/accept', { key: 'TERMS', version: '1' })).status).toBe(
      201,
    );
    expect((await me(p.accessToken, '/records')).body.data).toHaveLength(1);
    const after = (await me(p.accessToken, '/policies')).body.data as Array<{
      key: string;
      accepted: boolean;
      acceptedVersion: string | null;
    }>;
    expect(after.find((x) => x.key === 'TERMS')).toMatchObject({
      accepted: true,
      acceptedVersion: '1',
    });
    // a policy for another role is not theirs to accept
    expect(
      (await mePost(p.accessToken, '/accept', { key: 'DRIVER_AGREEMENT', version: '1' })).status,
    ).toBe(404);
    expect((await mePost(p.accessToken, '/accept', { key: 'NOPE', version: '1' })).status).toBe(
      404,
    );
    expect((await mePost(p.accessToken, '/accept', { key: 'TERMS' })).status).toBe(400);
    expect((await api.get('/api/v1/compliance/policies')).status).toBe(401);
  });

  it('asks again when a new version is published, and keeps what was accepted before', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    try {
      await mePost(p.accessToken, '/accept', { key: 'TERMS', version: '1' });
      expect(
        (await admPost(a.token, '/policies/TERMS/publish', { version: '1', reason: 'same' }))
          .status,
      ).toBe(409);
      expect((await admPost(a.token, '/policies/TERMS/publish', { version: '2' })).status).toBe(
        400,
      ); // reason needed
      const pub = await admPost(a.token, '/policies/TERMS/publish', {
        version: '2',
        contentUrl: 'https://yatri.example/terms/2',
        reason: 'New cancellation wording',
      });
      expect(pub.status).toBe(200);
      expect(pub.body.data).toMatchObject({
        version: '2',
        contentUrl: 'https://yatri.example/terms/2',
      });
      const now = (await me(p.accessToken, '/policies')).body.data as Array<{
        key: string;
        accepted: boolean;
        version: string;
        acceptedVersion: string;
      }>;
      expect(now.find((x) => x.key === 'TERMS')).toMatchObject({
        accepted: false,
        version: '2',
        acceptedVersion: '1',
      });
      // accepting the version they read before is refused; the new one is recorded alongside
      const stale = await mePost(p.accessToken, '/accept', { key: 'TERMS', version: '1' });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('POLICY_VERSION_CHANGED');
      expect((await mePost(p.accessToken, '/accept', { key: 'TERMS', version: '2' })).status).toBe(
        201,
      );
      const records = (await me(p.accessToken, '/records')).body.data as Array<{
        policyVersion: string;
      }>;
      expect(records.map((r) => r.policyVersion).sort()).toEqual(['1', '2']);
      // the admin can see what a person agreed to, and that read is recorded
      const seen = await adm(a.token, `/users/${p.user.id}/records`);
      expect(seen.body.data).toHaveLength(2);
      const audited = await pool.query(
        `SELECT 1 FROM audit_log WHERE action = 'VIEW_COMPLIANCE_RECORDS' AND actor_id = $1`,
        [a.id],
      );
      expect(audited.rowCount).toBe(1);
      const published = await pool.query(
        `SELECT 1 FROM audit_log WHERE action = 'POLICY_PUBLISHED'`,
      );
      expect(published.rowCount).toBe(1);
    } finally {
      await resetPolicy();
    }
  });

  it('holds the policy words nowhere: only a version and an address', async () => {
    const cols = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name IN ('compliance_policies', 'compliance_records')`,
      )
    ).rows.map((r) => r.column_name as string);
    for (const c of cols) expect(['content', 'body', 'text', 'html']).not.toContain(c);
    expect(cols).toContain('content_url');
    expect(cols).toContain('policy_version');
    // append-only by design: no update path in the API, and a record cannot be attached to a missing policy
    await onboardUser('PASSENGER');
    await expect(
      pool.query(
        `INSERT INTO compliance_records (user_id, policy_key, policy_version) SELECT id, 'NO_SUCH', '1' FROM users LIMIT 1`,
      ),
    ).rejects.toBeDefined();
  });

  it('needs COMPLIANCE_MANAGE for every administrator route', async () => {
    const plain = await admin(['OPERATIONS_VIEW']);
    const p = await onboardUser('PASSENGER');
    for (const path of ['/policies', '/data-requests', '/retention']) {
      expect((await adm(plain.token, path)).status, path).toBe(403);
      expect((await adm(p.accessToken, path)).status, path).toBe(403);
      expect((await api.get(`/api/v1/admin/compliance${path}`)).status, path).toBe(401);
    }
    expect(
      (await admPost(plain.token, '/policies/TERMS/publish', { version: '9', reason: 'nope' }))
        .status,
    ).toBe(403);
  });
});

describe('data requests: one definition of the lifecycle', () => {
  it('has a table whose moves agree in both directions', () => {
    for (const to of DATA_REQUEST_STATES) {
      for (const from of dataRequestStatesLeadingTo(to))
        expect(DATA_REQUEST_TRANSITIONS[from]).toContain(to);
    }
    expect(canDataRequestTransition('REVIEWING', 'CANCELLED')).toBe(false); // too late to withdraw
    for (const s of ['COMPLETED', 'REJECTED', 'CANCELLED'] as const)
      expect(DATA_REQUEST_TRANSITIONS[s]).toEqual([]);
  });
});

describe('asking for data or deletion', () => {
  it('creates a request with a due date from the setting, one open per kind', async () => {
    const p = await onboardUser('PASSENGER');
    const r = await mePost(p.accessToken, '/data-requests', {
      kind: 'DATA_ACCESS',
      note: 'For my records',
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      kind: 'DATA_ACCESS',
      status: 'REQUESTED',
      canCancel: true,
      canDownload: false,
    });
    const days = (new Date(r.body.data.dueAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect((await mePost(p.accessToken, '/data-requests', { kind: 'DATA_ACCESS' })).status).toBe(
      409,
    );
    expect(
      (await mePost(p.accessToken, '/data-requests', { kind: 'ACCOUNT_DELETION' })).status,
    ).toBe(201);
    expect((await mePost(p.accessToken, '/data-requests', { kind: 'NOPE' })).status).toBe(400);
    expect((await me(p.accessToken, '/data-requests')).body.data).toHaveLength(2);
    // withdrawn, then a new one may be made
    expect(
      (await mePost(p.accessToken, `/data-requests/${r.body.data.id}/cancel`)).body.data.status,
    ).toBe('CANCELLED');
    expect((await mePost(p.accessToken, `/data-requests/${r.body.data.id}/cancel`)).status).toBe(
      409,
    );
    expect((await mePost(p.accessToken, '/data-requests', { kind: 'DATA_ACCESS' })).status).toBe(
      201,
    );
  });

  it('is private to the person and cannot be withdrawn once someone started', async () => {
    const p = await onboardUser('PASSENGER');
    const other = await onboardUser('PASSENGER');
    const a = await admin();
    const r = (await mePost(p.accessToken, '/data-requests', { kind: 'DATA_ACCESS' })).body.data;
    expect((await me(other.accessToken, '/data-requests')).body.data).toEqual([]);
    expect((await mePost(other.accessToken, `/data-requests/${r.id}/cancel`)).status).toBe(404);
    expect(
      (await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'REVIEWING' })).status,
    ).toBe(200);
    const late = await mePost(p.accessToken, `/data-requests/${r.id}/cancel`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CANNOT_CANCEL');
    // an administrator cannot withdraw on the person's behalf, nor skip steps
    expect(
      (await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'CANCELLED' })).status,
    ).toBe(409);
    expect(
      (await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'REQUESTED' })).status,
    ).toBe(409);
    const told = await pool.query(
      `SELECT body FROM notifications WHERE user_id = $1 AND type = 'DATA_REQUEST_UPDATE'`,
      [p.user.id],
    );
    expect(told.rows[0].body).toContain('being handled');
  });

  it('produces a personal-data copy only when done, with the person’s own data and never others’ notes', async () => {
    const w = await finishedRide();
    const a = await admin();
    const t = await api.post('/api/v1/support/tickets').set(auth(w.passenger.accessToken)).send({
      categoryCode: 'APP_PROBLEM',
      subject: 'The map',
      body: 'The map will not load for me',
    });
    const supportAdmin = await admin(['SUPPORT_MANAGE', 'DISPUTES_MANAGE']);
    await api
      .post(`/api/v1/admin/support/tickets/${t.body.data.id}/notes`)
      .set(auth(supportAdmin.token))
      .send({ body: 'INTERNAL-ONLY note' });
    const r = (await mePost(w.passenger.accessToken, '/data-requests', { kind: 'DATA_ACCESS' }))
      .body.data;
    expect((await me(w.passenger.accessToken, `/data-requests/${r.id}/export`)).status).toBe(409); // not ready
    await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'REVIEWING' });
    await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'COMPLETED' });
    const done = (await me(w.passenger.accessToken, '/data-requests')).body.data[0];
    expect(done).toMatchObject({ status: 'COMPLETED', canDownload: true });
    const res = await me(w.passenger.accessToken, `/data-requests/${r.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const data = res.body.data;
    expect(data.profile.id).toBe(w.passengerId);
    expect(data.rides).toHaveLength(1);
    expect(data.supportRequests).toHaveLength(1);
    const text = JSON.stringify(data);
    expect(text).not.toContain('INTERNAL-ONLY');
    expect(text).not.toContain(w.driver.phoneNumber); // the other person's details are not in it
    expect(text).not.toContain('password_hash');
    // nobody else can fetch it, and the download is recorded
    const other = await onboardUser('PASSENGER');
    expect((await me(other.accessToken, `/data-requests/${r.id}/export`)).status).toBe(404);
    const audited = await pool.query(
      `SELECT 1 FROM audit_log WHERE action = 'DATA_EXPORT_DOWNLOADED' AND actor_id = $1`,
      [w.passengerId],
    );
    expect(audited.rowCount).toBe(1);
  });

  it('rejects with a reason and lists overdue requests first', async () => {
    const p = await onboardUser('PASSENGER');
    const q = await onboardUser('PASSENGER');
    const a = await admin();
    const r1 = (await mePost(p.accessToken, '/data-requests', { kind: 'DATA_ACCESS' })).body.data;
    const r2 = (await mePost(q.accessToken, '/data-requests', { kind: 'DATA_ACCESS' })).body.data;
    await pool.query(`UPDATE data_requests SET due_at = now() - interval '2 days' WHERE id = $1`, [
      r2.id,
    ]);
    const list = (await adm(a.token, '/data-requests?open=true')).body.data;
    expect(list.items[0]).toMatchObject({ id: r2.id, overdue: true });
    expect(list.items[1]).toMatchObject({ id: r1.id, overdue: false });
    expect(
      (await admPost(a.token, `/data-requests/${r1.id}/action`, { to: 'REJECTED' })).status,
    ).toBe(400);
    const rej = await admPost(a.token, `/data-requests/${r1.id}/action`, {
      to: 'REJECTED',
      note: 'We could not verify who you are.',
    });
    expect(rej.body.data).toMatchObject({
      status: 'REJECTED',
      decisionNote: 'We could not verify who you are.',
    });
    expect((await adm(a.token, '/data-requests?status=REJECTED')).body.data.total).toBe(1);
  });
});

describe('account deletion', () => {
  it('anonymises the person, keeps what must be kept, and removes what is only theirs', async () => {
    const w = await finishedRide();
    const a = await admin();
    const uid = w.passengerId;
    await pool.query(
      `INSERT INTO emergency_contacts (user_id, name, phone_number) VALUES ($1, 'Mum', '+9779811111111')`,
      [uid],
    );
    await api.post(`/api/v1/support/tickets`).set(auth(w.passenger.accessToken)).send({
      categoryCode: 'RIDE_FARE',
      subject: 'Fare',
      body: 'Fare was higher than shown',
      tripId: w.tripId,
    });
    await mePost(w.passenger.accessToken, '/accept', { key: 'TERMS', version: '1' });
    await pool.query(
      `UPDATE support_tickets SET status = 'CLOSED', closed_at = now() WHERE requester_id = $1`,
      [uid],
    );
    const r = (
      await mePost(w.passenger.accessToken, '/data-requests', { kind: 'ACCOUNT_DELETION' })
    ).body.data;
    await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'REVIEWING' });
    const done = await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'COMPLETED' });
    expect(done.status).toBe(200);

    const u = (
      await pool.query(
        'SELECT full_name, phone_number, email, status, profile_picture_url FROM users WHERE id = $1',
        [uid],
      )
    ).rows[0];
    expect(u).toMatchObject({
      full_name: 'Deleted account',
      phone_number: null,
      email: null,
      status: 'DEACTIVATED',
    });
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM emergency_contacts WHERE user_id = $1', [
          uid,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [uid]))
        .rows[0].n,
    ).toBe(0);
    // records that must be kept are still there
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM trips WHERE id = $1', [w.tripId])).rows[0]
        .n,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM trip_payments WHERE trip_id = $1', [
          w.tripId,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM support_tickets WHERE requester_id = $1', [
          uid,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM compliance_records WHERE user_id = $1', [
          uid,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await pool.query(`SELECT status FROM data_requests WHERE id = $1`, [r.id])).rows[0].status,
    ).toBe('COMPLETED');
    // the old session no longer works (and the number, now unattached, is free to sign up again)
    expect(
      (await api.get('/api/v1/support/tickets').set(auth(w.passenger.accessToken))).status,
    ).toBe(401);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM users WHERE phone_number = $1', [
          w.passenger.phoneNumber,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('removes a driver’s identity documents from storage but keeps their rides', async () => {
    const d = await onboardUser('DRIVER');
    const a = await admin();
    const up = await uploadDocument(d.accessToken, 'DRIVING_LICENSE', FIXTURES.jpeg, 'licence.jpg');
    expect(up.status).toBe(201);
    const key = (
      await pool.query('SELECT storage_key FROM documents WHERE driver_user_id = $1', [d.user.id])
    ).rows[0].storage_key as string;
    const r = (await mePost(d.accessToken, '/data-requests', { kind: 'ACCOUNT_DELETION' })).body
      .data;
    await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'REVIEWING' });
    expect(
      (await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'COMPLETED' })).status,
    ).toBe(200);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM documents WHERE driver_user_id = $1', [
          d.user.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    const { getStorageProvider } = await import('../lib/storage/local-disk-provider');
    await expect(getStorageProvider().download(key)).rejects.toBeDefined();
  });

  it('refuses while a ride is under way, and says why', async () => {
    const w = await rideWorld(); // a ride in progress for both
    const a = await admin();
    const r = (
      await mePost(w.passenger.accessToken, '/data-requests', { kind: 'ACCOUNT_DELETION' })
    ).body.data;
    await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'REVIEWING' });
    const blocked = await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'COMPLETED' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('DELETION_BLOCKED');
    expect(blocked.body.error.message).toContain('ride is still under way');
    const still = (
      await pool.query('SELECT status, full_name FROM users WHERE id = $1', [w.passengerId])
    ).rows[0];
    expect(still.status).toBe('ACTIVE');
    expect(still.full_name).not.toBe('Deleted account');
    expect(
      (await pool.query('SELECT status FROM data_requests WHERE id = $1', [r.id])).rows[0].status,
    ).toBe('REVIEWING');
  });

  it('refuses while the ride’s cash payment is unsettled', async () => {
    const w = await finishedRide(false);
    const a = await admin();
    const r = (
      await mePost(w.passenger.accessToken, '/data-requests', { kind: 'ACCOUNT_DELETION' })
    ).body.data;
    await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'REVIEWING' });
    const blocked = await admPost(a.token, `/data-requests/${r.id}/action`, { to: 'COMPLETED' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('payment that is not settled');
  });
});

describe('retention', () => {
  it('seeds one rule per kind of record, and keeps what must be kept', async () => {
    const list = (await adm((await admin()).token, '/retention')).body.data as Array<{
      recordType: string;
      action: string;
      retainDays: number | null;
      legalBasis: string;
    }>;
    expect(list.map((x) => x.recordType)).toEqual([...RETENTION_RECORD_TYPES]);
    for (const k of [
      'TRIPS',
      'PAYMENTS',
      'REFUNDS',
      'SUPPORT_TICKETS',
      'SAFETY_RECORDS',
      'AUDIT_LOG',
      'COMPLIANCE_RECORDS',
      'DATA_REQUESTS',
    ]) {
      expect(list.find((x) => x.recordType === k)).toMatchObject({
        action: 'KEEP',
        retainDays: null,
      });
    }
    for (const x of list) expect(x.legalBasis.length).toBeGreaterThan(10);
  });

  it('changes a period only with a reason, never below its floor, never for kept records', async () => {
    const a = await admin();
    try {
      expect((await admPatch(a.token, '/retention/NOTIFICATIONS', { retainDays: 60 })).status).toBe(
        400,
      );
      const low = await admPatch(a.token, '/retention/NOTIFICATIONS', {
        retainDays: 5,
        reason: 'shorter',
      });
      expect(low.status).toBe(400);
      expect(low.body.error.code).toBe('BELOW_MINIMUM');
      const ok = await admPatch(a.token, '/retention/NOTIFICATIONS', {
        retainDays: 60,
        reason: 'Policy review',
      });
      expect(ok.body.data.retainDays).toBe(60);
      const kept = await admPatch(a.token, '/retention/PAYMENTS', {
        retainDays: 30,
        reason: 'free up space',
      });
      expect(kept.status).toBe(409);
      expect(kept.body.error.code).toBe('MUST_BE_KEPT');
      expect(
        (await admPatch(a.token, '/retention/NOT_A_TYPE', { retainDays: 30, reason: 'hello' }))
          .status,
      ).toBe(404);
      const audited = await pool.query(
        `SELECT detail FROM audit_log WHERE action = 'RETENTION_POLICY_UPDATED'`,
      );
      expect(audited.rows[0].detail).toMatchObject({
        recordType: 'NOTIFICATIONS',
        from: 180,
        to: 60,
      });
    } finally {
      await pool.query(
        `UPDATE retention_policies SET retain_days = 180 WHERE record_type = 'NOTIFICATIONS'`,
      );
    }
  });

  it('deletes by the stored periods and only what is due, and records the run', async () => {
    const p = await onboardUser('PASSENGER');
    const uid = p.user.id as string;
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, created_at) VALUES ($1, 'X', 't', 'old', now() - interval '200 days'), ($1, 'X', 't', 'new', now() - interval '10 days')`,
      [uid],
    );
    const done = await runRetention();
    expect(done.NOTIFICATIONS).toBeGreaterThanOrEqual(1);
    const left = (
      await pool.query(`SELECT body FROM notifications WHERE user_id = $1 AND type = 'X'`, [uid])
    ).rows.map((r) => r.body);
    expect(left).toEqual(['new']);
    const run = (
      await pool.query(
        `SELECT last_run_at, last_run_count FROM retention_policies WHERE record_type = 'NOTIFICATIONS'`,
      )
    ).rows[0];
    expect(run.last_run_at).not.toBeNull();
    // the audit log, payments and tickets are never touched by any job
    expect(
      Object.keys(done).every(
        (k) => !['AUDIT_LOG', 'PAYMENTS', 'TRIPS', 'SUPPORT_TICKETS'].includes(k),
      ),
    ).toBe(true);
  });

  it('removes evidence of long-closed tickets and leaves the ticket itself', async () => {
    const p = await onboardUser('PASSENGER');
    const t = (
      await api
        .post('/api/v1/support/tickets')
        .set(auth(p.accessToken))
        .send({ categoryCode: 'APP_PROBLEM', subject: 'Map', body: 'The map will not load for me' })
    ).body.data;
    const up = await api
      .post(`/api/v1/support/tickets/${t.id}/attachments`)
      .set(auth(p.accessToken))
      .attach('file', FIXTURES.png, 's.png');
    expect(up.status).toBe(201);
    const key = (await pool.query('SELECT storage_key FROM support_attachments LIMIT 1')).rows[0]
      .storage_key as string;
    await pool.query(
      `UPDATE support_tickets SET status = 'CLOSED', closed_at = now() - interval '800 days' WHERE id = $1`,
      [t.id],
    );
    expect((await runRetention()).SUPPORT_EVIDENCE).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM support_attachments')).rows[0].n).toBe(
      0,
    );
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM support_tickets WHERE id = $1', [t.id]))
        .rows[0].n,
    ).toBe(1);
    const { getStorageProvider } = await import('../lib/storage/local-disk-provider');
    await expect(getStorageProvider().download(key)).rejects.toBeDefined();
  });
});
