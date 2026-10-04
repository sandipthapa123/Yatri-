import { env } from '../config/env';
import {
  PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  canPayoutTransition,
  driverPayableForRide,
  driverPayoutSentences,
  maskedAccount,
  normalizeAccountNumber,
  payoutAccountProblem,
  type AdminPayoutDetail,
  type AdminPayoutList,
  type AdminPermission,
  type DigitalPaymentInfo,
  type DriverPayoutSummary,
  type FinanceSummary,
} from '@yatri/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { decryptField, encryptField } from '../lib/crypto';
import { SandboxGateway } from '../modules/payments/sandbox-gateway';
import { setPaymentGatewayForTests, type PaymentGateway } from '../modules/payments/gateway';
import { ProviderError } from '../modules/providers/errors';
import { refreshSettings } from '../modules/settings/settings.service';
import { sweepOnlineRefunds } from '../modules/support/refunds.service';
import { api, loginTestAdmin } from './helpers';
import { auth, finishedRide, type RideWorld } from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
async function staff(permissions: AdminPermission[]) {
  const email = `payout-admin-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1', permissions);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id as string;
  return { token, id };
}
const supportStaff = () => staff(['DISPUTES_MANAGE', 'SUPPORT_MANAGE', 'REFUNDS_MANAGE']);
const payoutStaff = (permissions: AdminPermission[] = ['PAYOUTS_MANAGE', 'FINANCE_VIEW']) => staff(permissions);
const sandbox = () => new SandboxGateway('https://api.example.test');

async function setSetting(key: string, value: string | number) {
  await pool.query(`INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`, [key, JSON.stringify(value)]);
  await refreshSettings();
}
async function clearSettings(...keys: string[]) {
  await pool.query('DELETE FROM platform_settings WHERE key = ANY($1)', [keys]);
  await refreshSettings();
}

/** A finished ride the rider paid ONLINE (through the sandbox gateway): the money Yatri now holds for the driver. */
async function onlineRide(gateway: PaymentGateway = sandbox()): Promise<RideWorld> {
  // Every test starts from emptied tables (platform settings included), so the payout rules are set again here: no hold, any amount.
  await setSetting('PAYOUT_HOLD_HOURS', 0);
  await setSetting('PAYOUT_MIN_NPR', 1);
  setPaymentGatewayForTests(gateway);
  const w = await finishedRide(false);
  const started = await api.post(`/api/v1/trips/${w.tripId}/payment/digital`).set(auth(w.passenger.accessToken));
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const done = await api.post(`/api/v1/trips/${w.tripId}/payment/digital/verify`).set(auth(w.passenger.accessToken));
  expect((done.body.data as DigitalPaymentInfo).status).toBe('COMPLETED');
  return w;
}
const paymentOf = async (tripId: string) => (await pool.query('SELECT id, amount_npr, method, status, provider_ref FROM trip_payments WHERE trip_id = $1', [tripId])).rows[0];
const fareOf = async (tripId: string) => (await pool.query('SELECT fare_final_npr FROM trips WHERE id = $1', [tripId])).rows[0].fare_final_npr as number;

const accountBody = { kind: 'BANK', holderName: 'Ram Bahadur Thapa', accountNumber: '0123 4567 8901' };
const saveAccount = (token: string, body: object = accountBody) => api.put('/api/v1/drivers/me/payout-account').set(auth(token)).send(body);
const summary = async (token: string) => (await api.get('/api/v1/drivers/me/payouts').set(auth(token))).body.data as DriverPayoutSummary;
const prepare = (token: string, driverId?: string) => api.post('/api/v1/admin/payouts/prepare').set(auth(token)).send(driverId ? { driverId } : {});
const act = (token: string, id: string, body: object) => api.post(`/api/v1/admin/payouts/${id}/act`).set(auth(token)).send(body);

afterEach(() => setPaymentGatewayForTests(undefined));
afterAll(async () => clearSettings('PAYOUT_HOLD_HOURS', 'PAYOUT_MIN_NPR', 'ONLINE_REFUND_DRIVER_SHARE_PERCENT'));

// ---------------------------------------------------------------- the pure rules

describe('payout rules (pure)', () => {
  it('owes the driver the full fare, less only the share of a refund the setting gives the driver', () => {
    expect(driverPayableForRide({ fareNpr: 400, refundedNpr: 0, driverSharePercent: 0 })).toBe(400);
    expect(driverPayableForRide({ fareNpr: 400, refundedNpr: 100, driverSharePercent: 0 })).toBe(400); // Yatri bears it
    expect(driverPayableForRide({ fareNpr: 400, refundedNpr: 100, driverSharePercent: 100 })).toBe(300);
    expect(driverPayableForRide({ fareNpr: 400, refundedNpr: 100, driverSharePercent: 50 })).toBe(350);
    expect(driverPayableForRide({ fareNpr: 400, refundedNpr: 900, driverSharePercent: 100 })).toBe(0); // never negative
  });

  it('has payout states whose moves are one-way at the end', () => {
    expect(PAYOUT_TRANSITIONS.PAID).toEqual([]);
    expect(PAYOUT_TRANSITIONS.CANCELLED).toEqual([]);
    expect(canPayoutTransition('PENDING', 'PAID')).toBe(false); // it must be sent first
    expect(canPayoutTransition('PROCESSING', 'PAID')).toBe(true);
    expect(canPayoutTransition('FAILED', 'PROCESSING')).toBe(true);
    for (const s of PAYOUT_STATUSES) expect(PAYOUT_TRANSITIONS[s]).not.toContain(s);
  });

  it('checks a payout account in words, and masks a number so a screen reader can say it', () => {
    expect(payoutAccountProblem(accountBody)).toBeNull();
    expect(payoutAccountProblem({ ...accountBody, holderName: 'R' })).toContain('name');
    expect(payoutAccountProblem({ ...accountBody, accountNumber: '12' })).toContain('needs');
    expect(payoutAccountProblem({ kind: 'KHALTI', holderName: 'Sita Rai', accountNumber: '98AB' + '12345' })).toContain('digits only');
    expect(payoutAccountProblem({ kind: 'CASH', holderName: 'Sita Rai', accountNumber: '9841234567' })).toContain('Choose');
    expect(normalizeAccountNumber('0123 4567-8901')).toBe('012345678901');
    expect(maskedAccount('8901')).toBe('ending in 8 9 0 1');
  });

  it('says in sentences what is ready, on hold, in a payout and paid, and that cash rides are the driver\'s own', () => {
    const text = driverPayoutSentences({ readyNpr: 900, holdingNpr: 300, inPayoutNpr: 0, paidNpr: 1200, minPayoutNpr: 500, holdHours: 48, account: null }).join(' ');
    expect(text).toContain('NPR 900 from online rides is ready');
    expect(text).toContain('on hold for 48 hours');
    expect(text).toContain('Cash rides are never part of a payout');
    expect(text).toContain('Add where payouts should go');
  });

  it('encrypts a number so it can be read back only with the same secret and purpose, and notices tampering', () => {
    const sealed = encryptField('012345678901', 's'.repeat(40), 'payout-account');
    expect(sealed).not.toContain('012345678901');
    expect(decryptField(sealed, 's'.repeat(40), 'payout-account')).toBe('012345678901');
    expect(() => decryptField(sealed, 'x'.repeat(40), 'payout-account')).toThrow();
    expect(() => decryptField(sealed, 's'.repeat(40), 'something-else')).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptField(parts.join('.'), 's'.repeat(40), 'payout-account')).toThrow();
    expect(encryptField('a', 's'.repeat(40), 'p')).not.toBe(encryptField('a', 's'.repeat(40), 'p')); // a fresh nonce each time
  });
});

// ---------------------------------------------------------------- refunds of online payments

describe('refunding an online payment', () => {
  /** A passenger asks for a full refund of an online ride, and two staff review and approve it; returns the refund id. */
  async function approvedRefund(w: RideWorld) {
    const ticket = await api.post('/api/v1/support/tickets').set(auth(w.passenger.accessToken)).send({
      categoryCode: 'RIDE_FARE', subject: 'Fare problem', body: 'I was charged more than the fare shown', tripId: w.tripId,
    });
    expect(ticket.status).toBe(201);
    const asked = await api.post(`/api/v1/support/tickets/${ticket.body.data.id}/refund`).set(auth(w.passenger.accessToken)).send({ reason: 'FULL_FARE' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = asked.body.data.id as string;
    const one = await supportStaff();
    const two = await supportStaff();
    const step = (t: string, body: object) => api.post(`/api/v1/admin/support/refunds/${id}/action`).set(auth(t)).send(body);
    expect((await step(one.token, { to: 'REVIEWING' })).status).toBe(200);
    expect((await step(two.token, { to: 'APPROVED' })).status).toBe(200);
    return { id, two, step };
  }
  const refundRow = async (id: string) => (await pool.query('SELECT status, method, reference, failed_reason FROM refunds WHERE id = $1', [id])).rows[0];

  it('returns the money through a provider that can, completes the refund with the provider\'s reference, and asks once', async () => {
    const asked: string[] = [];
    const gateway: PaymentGateway = { ...sandbox(), name: 'sandbox', supportsRefund: true, initiate: (r) => sandbox().initiate(r), lookup: (ref) => sandbox().lookup(ref), refund: async (r) => { asked.push(r.refundId); return { refundRef: `rf_${r.refundId}`, state: 'COMPLETED' }; } };
    const w = await onlineRide(gateway);
    const { id, two, step } = await approvedRefund(w);
    const res = await step(two.token, { to: 'PROCESSING' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await refundRow(id);
    expect(row).toMatchObject({ status: 'COMPLETED', method: 'PLATFORM', reference: `rf_${id}` });
    expect(asked).toEqual([id]); // the refund's own id is the idempotency key, sent once
    await sweepOnlineRefunds();
    expect(asked).toEqual([id]); // finished refunds are not asked about again
    const audit = await pool.query(`SELECT actor_role FROM audit_log WHERE action = 'REFUND_STATUS_CHANGED' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]);
    expect(audit.rows[0].actor_role).toBe('SYSTEM'); // the completion was the system's, and is audited
  });

  it('never lets the driver "return cash" for a payment that was made online', async () => {
    const w = await onlineRide();
    const { id, two, step } = await approvedRefund(w);
    const res = await step(two.token, { to: 'PROCESSING', method: 'DRIVER_CASH' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('paid online');
    expect((await refundRow(id)).status).toBe('APPROVED');
  });

  it('leaves a refund to staff when the provider cannot refund by API, and then needs the provider\'s reference', async () => {
    const manual: PaymentGateway = { ...sandbox(), name: 'sandbox', supportsRefund: false, initiate: (r) => sandbox().initiate(r), lookup: (ref) => sandbox().lookup(ref) };
    const w = await onlineRide(manual);
    const { id, two, step } = await approvedRefund(w);
    expect((await step(two.token, { to: 'PROCESSING' })).status).toBe(200);
    expect((await refundRow(id)).status).toBe('PROCESSING');
    const without = await step(two.token, { to: 'COMPLETED' });
    expect(without.status).toBe(400);
    expect(without.body.error.message).toContain('reference');
    expect((await step(two.token, { to: 'COMPLETED', reference: 'KHALTI-DASH-4821' })).status).toBe(200);
    expect(await refundRow(id)).toMatchObject({ status: 'COMPLETED', reference: 'KHALTI-DASH-4821', method: 'PLATFORM' });
  });

  it('keeps asking after a passing failure, and pays back exactly once', async () => {
    let calls = 0;
    const ids = new Set<string>();
    const flaky: PaymentGateway = {
      ...sandbox(), name: 'sandbox', supportsRefund: true, initiate: (r) => sandbox().initiate(r), lookup: (ref) => sandbox().lookup(ref),
      refund: async (r) => { calls += 1; ids.add(r.refundId); if (calls === 1) throw new ProviderError('PAYMENTS', 'sandbox', 'TIMEOUT'); return { refundRef: `rf_${r.refundId}`, state: 'COMPLETED' }; },
    };
    const w = await onlineRide(flaky);
    const { id, two, step } = await approvedRefund(w);
    expect((await step(two.token, { to: 'PROCESSING' })).status).toBe(200);
    expect((await refundRow(id)).status).toBe('PROCESSING'); // the provider timed out: not lost, not finished
    await pool.query(`UPDATE refunds SET updated_at = now() - interval '5 minutes' WHERE id = $1`, [id]);
    const first = await sweepOnlineRefunds();
    expect(first.completed).toBe(1);
    await sweepOnlineRefunds();
    expect(ids.size).toBe(1); // always the same idempotency key
    expect(await refundRow(id)).toMatchObject({ status: 'COMPLETED', reference: `rf_${id}` });
    const paid = await pool.query(`SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1 AND status = 'COMPLETED'`, [(await paymentOf(w.tripId)).id]);
    expect(paid.rows[0].n).toBe(1);
  });

  it('fails a refund the provider refuses, in plain words and never the provider\'s own, and lets staff try again', async () => {
    let refuse = true;
    const picky: PaymentGateway = {
      ...sandbox(), name: 'sandbox', supportsRefund: true, initiate: (r) => sandbox().initiate(r), lookup: (ref) => sandbox().lookup(ref),
      refund: async (r) => { if (refuse) throw new ProviderError('PAYMENTS', 'sandbox', 'BAD_REQUEST', 400); return { refundRef: `rf_${r.refundId}`, state: 'COMPLETED' }; },
    };
    const w = await onlineRide(picky);
    const { id, two, step } = await approvedRefund(w);
    await step(two.token, { to: 'PROCESSING' });
    const row = await refundRow(id);
    expect(row.status).toBe('FAILED');
    expect(row.failed_reason).toContain('payment provider');
    expect(row.failed_reason).not.toMatch(/BAD_REQUEST|400|sandbox/);
    refuse = false;
    expect((await step(two.token, { to: 'PROCESSING' })).status).toBe(200);
    expect((await refundRow(id)).status).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------- the driver's money

describe('what a driver is owed for online rides', () => {
  it('counts only rides paid online, and says so in sentences; a cash ride is the driver\'s own cash', async () => {
    const online = await onlineRide();
    const cash = await finishedRide(true, online.driver); // the same driver, paid in cash
    void cash;
    const s = await summary(online.driver.accessToken);
    const fare = await fareOf(online.tripId);
    expect(s.readyNpr).toBe(fare);
    expect(s.sentences.join(' ')).toContain(`NPR ${fare} from online rides is ready`);
    expect(s.sentences.join(' ')).toContain('Cash rides are never part of a payout');
    expect(s.account).toBeNull();
  });

  it('holds a ride for the hold period, then releases it', async () => {
    try {
      const w = await onlineRide();
      await setSetting('PAYOUT_HOLD_HOURS', 48);
      const held = await summary(w.driver.accessToken);
      expect(held.readyNpr).toBe(0);
      expect(held.holdingNpr).toBe(await fareOf(w.tripId));
      await pool.query(`UPDATE trip_payments SET paid_at = now() - interval '49 hours' WHERE trip_id = $1`, [w.tripId]);
      expect((await summary(w.driver.accessToken)).readyNpr).toBe(await fareOf(w.tripId));
    } finally {
      await setSetting('PAYOUT_HOLD_HOURS', 0);
    }
  });

  it('keeps a payout account private: the driver sees the last four characters, the database holds ciphertext', async () => {
    const w = await finishedRide(true);
    const res = await saveAccount(w.driver.accessToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = res.body.data as DriverPayoutSummary;
    expect(s.account).toEqual({ kind: 'BANK', holderName: 'Ram Bahadur Thapa', last4: '8901' });
    expect(JSON.stringify(s)).not.toContain('012345678901');
    const row = (await pool.query('SELECT account_cipher, account_last4 FROM driver_payout_accounts WHERE driver_id = $1', [w.driverId])).rows[0];
    expect(row.account_cipher).not.toContain('8901');
    expect((await saveAccount(w.driver.accessToken, { ...accountBody, accountNumber: '12' })).status).toBe(400);
    expect((await saveAccount(w.driver.accessToken, { ...accountBody, kind: 'CASH' })).status).toBe(400);
    expect((await saveAccount(w.passenger.accessToken)).status).toBe(403); // drivers only
    expect((await api.get('/api/v1/drivers/me/payouts')).status).toBe(401);
  });
});

// ---------------------------------------------------------------- preparing and sending payouts

describe('payouts', () => {
  it('needs an account and an amount, pays the full fare, and puts each ride in at most one payout', async () => {
    const w = await onlineRide();
    const admin = await payoutStaff();
    const none = await prepare(admin.token, w.driverId);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NO_PAYOUT_ACCOUNT');
    await saveAccount(w.driver.accessToken);
    const made = await prepare(admin.token, w.driverId);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.data).toMatchObject({ amountNpr: await fareOf(w.tripId), rides: 1, status: 'PENDING' });
    const again = await prepare(admin.token, w.driverId);
    expect(again.status).toBe(409); // that ride is already in a payout
    expect(again.body.error.code).toBe('BELOW_MINIMUM');
    const items = await pool.query('SELECT count(*)::int AS n FROM driver_payout_items WHERE trip_id = $1', [w.tripId]);
    expect(items.rows[0].n).toBe(1);
    expect((await summary(w.driver.accessToken)).inPayoutNpr).toBe(await fareOf(w.tripId));
  });

  it('prepares the same money only once when two staff press the button together', async () => {
    const w = await onlineRide();
    await saveAccount(w.driver.accessToken);
    const a = await payoutStaff();
    const b = await payoutStaff();
    const [x, y] = await Promise.all([prepare(a.token, w.driverId), prepare(b.token, w.driverId)]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const count = await pool.query('SELECT count(*)::int AS n FROM driver_payouts WHERE driver_id = $1', [w.driverId]);
    expect(count.rows[0].n).toBe(1);
  });

  it('prepares for everyone who is ready, and skips (and counts) a driver with nowhere to send it', async () => {
    const ready = await onlineRide();
    await saveAccount(ready.driver.accessToken);
    await onlineRide(); // another driver, no account
    const admin = await payoutStaff();
    const res = await prepare(admin.token);
    expect(res.status).toBe(201);
    expect(res.body.data.prepared).toBeGreaterThanOrEqual(1);
    expect(res.body.data.skipped).toBeGreaterThanOrEqual(1);
    const mine = await pool.query('SELECT 1 FROM driver_payouts WHERE driver_id = $1', [ready.driverId]);
    expect(mine.rowCount).toBe(1);
  });

  it('keeps a ride out while a refund on it is being decided, and takes the driver\'s share of a completed refund off', async () => {
    const w = await onlineRide();
    await saveAccount(w.driver.accessToken);
    const payId = (await paymentOf(w.tripId)).id as string;
    await pool.query(`INSERT INTO refunds (trip_id, payment_id, requested_by_role, amount_npr, reason, status) VALUES ($1, $2, 'ADMIN', 10, 'PARTIAL', 'REVIEWING')`, [w.tripId, payId]);
    const admin = await payoutStaff();
    expect((await prepare(admin.token, w.driverId)).status).toBe(409); // a refund is under way
    await pool.query(`UPDATE refunds SET status = 'COMPLETED', method = 'PLATFORM', completed_at = now() WHERE payment_id = $1`, [payId]);
    await setSetting('ONLINE_REFUND_DRIVER_SHARE_PERCENT', 100);
    try {
      const made = await prepare(admin.token, w.driverId);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(made.body.data.amountNpr).toBe((await fareOf(w.tripId)) - 10);
    } finally {
      await clearSettings('ONLINE_REFUND_DRIVER_SHARE_PERCENT');
    }
  });

  it('moves a payout only by the table, needs a reference to mark it paid, and never lets the preparer confirm it', async () => {
    const w = await onlineRide();
    await saveAccount(w.driver.accessToken);
    const preparer = await payoutStaff();
    const sender = await payoutStaff();
    const id = (await prepare(preparer.token, w.driverId)).body.data.id as string;
    expect((await act(sender.token, id, { to: 'PAID', reference: 'TXN-1' })).body.error.code).toBe('INVALID_PAYOUT_TRANSITION'); // must be sent first
    expect((await act(sender.token, id, { to: 'PROCESSING' })).status).toBe(200);
    expect((await act(preparer.token, id, { to: 'PAID', reference: 'TXN-1' })).body.error.code).toBe('FOUR_EYES');
    expect((await act(sender.token, id, { to: 'PAID' })).status).toBe(400); // a reference is required
    expect((await act(sender.token, id, { to: 'FAILED' })).status).toBe(400); // and a reason
    expect((await act(sender.token, id, { to: 'FAILED', failedReason: 'The bank returned the transfer.' })).status).toBe(200);
    const failedNote = await pool.query(`SELECT body FROM notifications WHERE user_id = $1 AND type = 'PAYMENT_PAYOUT_FAILED'`, [w.driverId]);
    expect(failedNote.rowCount).toBe(1);
    expect((await act(sender.token, id, { to: 'PROCESSING' })).status).toBe(200); // tried again
    const paid = await act(sender.token, id, { to: 'PAID', reference: 'TXN-2' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.status).toBe('PAID');
    expect((await act(sender.token, id, { to: 'CANCELLED' })).body.error.code).toBe('INVALID_PAYOUT_TRANSITION'); // paid is final
    const mine = await summary(w.driver.accessToken);
    expect(mine.paidNpr).toBe(await fareOf(w.tripId));
    expect(mine.payouts[0]).toMatchObject({ status: 'PAID', reference: 'TXN-2' });
    const sent = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'PAYMENT_PAYOUT_SENT'`, [w.driverId]);
    expect(sent.rowCount).toBe(1);
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE subject_id = $1 AND action IN ('PAYOUT_PREPARED', 'PAYOUT_STATUS_CHANGED')`, [id]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it('lets go of the rides of a cancelled payout so a later payout pays them', async () => {
    const w = await onlineRide();
    await saveAccount(w.driver.accessToken);
    const admin = await payoutStaff();
    const id = (await prepare(admin.token, w.driverId)).body.data.id as string;
    expect((await act(admin.token, id, { to: 'CANCELLED' })).status).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM driver_payout_items WHERE trip_id = $1', [w.tripId])).rows[0].n).toBe(0);
    expect((await summary(w.driver.accessToken)).readyNpr).toBe(await fareOf(w.tripId));
    expect((await prepare(admin.token, w.driverId)).status).toBe(201);
  });

  it('pays to the account that was saved when the payout was prepared, even if the driver changes it afterwards', async () => {
    const w = await onlineRide();
    await saveAccount(w.driver.accessToken);
    const admin = await payoutStaff();
    const id = (await prepare(admin.token, w.driverId)).body.data.id as string;
    await saveAccount(w.driver.accessToken, { kind: 'KHALTI', holderName: 'Someone Else', accountNumber: '9841000000' });
    const reveal = await api.get(`/api/v1/admin/payouts/${id}/account`).set(auth(admin.token));
    expect(reveal.status).toBe(200);
    expect(reveal.body.data).toMatchObject({ kind: 'BANK', holder: 'Ram Bahadur Thapa', number: '012345678901' });
  });

  it('seals new accounts with their own secret, and still opens one sealed before that secret existed', async () => {
    const w = await onlineRide();
    await saveAccount(w.driver.accessToken);
    const saved = (await pool.query('SELECT account_cipher FROM driver_payout_accounts WHERE driver_id = $1', [w.driverId])).rows[0];
    expect(decryptField(saved.account_cipher, env.FIELD_ENCRYPTION_SECRET, 'payout-account')).toBe('012345678901');
    expect(() => decryptField(saved.account_cipher, env.STORAGE_SIGNING_SECRET, 'payout-account')).toThrow();
    const admin = await payoutStaff();
    const id = (await prepare(admin.token, w.driverId)).body.data.id as string;
    // as it was stored before payout details had their own secret
    await pool.query('UPDATE driver_payouts SET account_cipher = $2 WHERE id = $1', [
      id,
      encryptField('012345678901', env.STORAGE_SIGNING_SECRET, 'payout-account'),
    ]);
    const reveal = await api.get(`/api/v1/admin/payouts/${id}/account`).set(auth(admin.token));
    expect(reveal.status).toBe(200);
    expect(reveal.body.data.number).toBe('012345678901');
  });
});

// ---------------------------------------------------------------- who may see what

describe('payouts: authorization and privacy', () => {
  it('shows the full account only to staff who manage payouts, and audits every opening', async () => {
    const w = await onlineRide();
    await saveAccount(w.driver.accessToken);
    const manager = await payoutStaff();
    const viewer = await payoutStaff(['PAYOUTS_VIEW']);
    const id = (await prepare(manager.token, w.driverId)).body.data.id as string;
    expect((await api.get(`/api/v1/admin/payouts/${id}/account`).set(auth(viewer.token))).status).toBe(403);
    expect((await api.get(`/api/v1/admin/payouts/${id}/account`).set(auth(w.driver.accessToken))).status).toBe(403);
    expect((await api.get(`/api/v1/admin/payouts/${id}/account`)).status).toBe(401);
    const opened = await api.get(`/api/v1/admin/payouts/${id}/account`).set(auth(manager.token));
    expect(opened.status).toBe(200);
    const audit = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'PAYOUT_ACCOUNT_VIEWED' AND subject_id = $1 AND actor_id = $2`, [id, manager.id]);
    expect(audit.rowCount).toBe(1);
    // the list and the detail never carry the number, only its last four characters
    const list = await api.get('/api/v1/admin/payouts').set(auth(viewer.token));
    expect(list.status).toBe(200);
    expect((list.body.data as AdminPayoutList).items.some((p) => p.id === id)).toBe(true);
    const detail = await api.get(`/api/v1/admin/payouts/${id}`).set(auth(viewer.token));
    expect((detail.body.data as AdminPayoutDetail).accountLast4).toBe('8901');
    expect(JSON.stringify([list.body, detail.body])).not.toContain('012345678901');
    // a viewer cannot prepare or act
    expect((await prepare(viewer.token, w.driverId)).status).toBe(403);
    expect((await act(viewer.token, id, { to: 'PROCESSING' })).status).toBe(403);
  });

  it('is for staff and the driver alone: riders and other drivers get nothing', async () => {
    const w = await onlineRide();
    await saveAccount(w.driver.accessToken);
    const other = await finishedRide(true);
    expect((await api.get('/api/v1/drivers/me/payouts').set(auth(w.passenger.accessToken))).status).toBe(403);
    expect((await api.get('/api/v1/admin/payouts').set(auth(w.driver.accessToken))).status).toBe(403);
    expect((await summary(other.driver.accessToken)).account).toBeNull(); // each driver sees only their own
  });

  it('reports real payout and online-payment figures to finance, and no longer says there are no payouts', async () => {
    const w = await onlineRide();
    await saveAccount(w.driver.accessToken);
    const admin = await payoutStaff();
    await prepare(admin.token, w.driverId);
    const res = await api.get('/api/v1/admin/finance/summary').set(auth(admin.token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const f = res.body.data as FinanceSummary;
    expect(f.payouts.inPayoutNpr).toBeGreaterThan(0);
    expect(f.onlineCollectedNpr).toBeGreaterThan(0);
    expect(JSON.stringify(f)).not.toContain('no wallets or payouts');
  });
});
