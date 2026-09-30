import {
  REFUND_STATES,
  REFUND_TRANSITIONS,
  canRefundTransition,
  refundStatesLeadingTo,
  type AdminPermission,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { quoteRefund, refundAmountFor } from '../modules/pricing/refunds';
import { api, loginTestAdmin } from './helpers';
import { auth, finishedRide, type RideWorld } from './rides';

let n = 0;
async function admin(
  permissions: AdminPermission[] = ['DISPUTES_MANAGE', 'SUPPORT_MANAGE', 'REFUNDS_MANAGE'],
) {
  const email = `refund-admin-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1', permissions);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  return { token, id: id as string };
}
const adminPost = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/admin/support${path}`).set(auth(token)).send(body);
const post = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/support${path}`).set(auth(token)).send(body);
const get = (token: string, path: string) => api.get(`/api/v1/support${path}`).set(auth(token));

async function dispute(w: RideWorld, categoryCode = 'RIDE_FARE') {
  const r = await post(w.passenger.accessToken, '/tickets', {
    categoryCode,
    subject: 'Fare problem',
    body: 'I was charged more than the fare shown',
    tripId: w.tripId,
  });
  expect(r.status).toBe(201);
  return r.body.data as { id: string };
}
const payment = async (tripId: string) =>
  (await pool.query('SELECT * FROM trip_payments WHERE trip_id = $1', [tripId])).rows[0];
const act = (token: string, id: string, body: object) =>
  adminPost(token, `/refunds/${id}/action`, body);

describe('the refund calculation: one function', () => {
  it('works out each reason from what was paid, what was refunded and the waiting charge', () => {
    const q = quoteRefund({ paidNpr: 300, refundedNpr: 0, waitingChargeNpr: 40 });
    expect(q).toMatchObject({ remainingNpr: 300, amounts: { FULL_FARE: 300, WAITING_CHARGE: 40 } });
    expect(refundAmountFor(q, 'FULL_FARE', undefined)).toEqual({ ok: true, amountNpr: 300 });
    expect(refundAmountFor(q, 'WAITING_CHARGE', undefined)).toEqual({ ok: true, amountNpr: 40 });
    expect(refundAmountFor(q, 'PARTIAL', 120)).toEqual({ ok: true, amountNpr: 120 });
    for (const bad of [0, -5, 1.5, 301, undefined]) {
      expect(refundAmountFor(q, 'PARTIAL', bad as number).ok).toBe(false);
    }
    const after = quoteRefund({ paidNpr: 300, refundedNpr: 120, waitingChargeNpr: 0 });
    expect(after.amounts.FULL_FARE).toBeNull(); // part was already paid back
    expect(after.amounts.WAITING_CHARGE).toBeNull(); // no waiting charge on this ride
    expect(refundAmountFor(after, 'PARTIAL', 181).ok).toBe(false);
    expect(refundAmountFor(after, 'PARTIAL', 180).ok).toBe(true);
    const none = quoteRefund({ paidNpr: 300, refundedNpr: 300, waitingChargeNpr: 0 });
    expect(refundAmountFor(none, 'PARTIAL', 1).ok).toBe(false);
  });

  it('has a refund table whose moves agree in both directions', () => {
    for (const to of REFUND_STATES) {
      for (const from of refundStatesLeadingTo(to)) expect(REFUND_TRANSITIONS[from]).toContain(to);
    }
    expect(REFUND_TRANSITIONS.COMPLETED).toEqual([]);
    expect(REFUND_TRANSITIONS.REJECTED).toEqual([]);
    expect(canRefundTransition('REQUESTED', 'COMPLETED')).toBe(false);
    for (const s of REFUND_STATES) expect(REFUND_TRANSITIONS[s]).not.toContain(s);
  });
});

describe('asking for a refund', () => {
  it('lets a passenger ask on a paid ride problem, with the amount from the server', async () => {
    const w = await finishedRide();
    const t = await dispute(w);
    const before = (await get(w.passenger.accessToken, `/tickets/${t.id}`)).body.data;
    expect(before.canRequestRefund).toBe(true);
    const paid = (await payment(w.tripId)).amount_npr as number;

    const r = await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, {
      reason: 'FULL_FARE',
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ amountNpr: paid, status: 'REQUESTED', tripId: w.tripId });
    expect(r.body.data.statusText).toContain(`NPR ${paid}`);
    const mine = (await get(w.passenger.accessToken, `/tickets/${t.id}`)).body.data;
    expect(mine.refund).toMatchObject({ status: 'REQUESTED' });
    expect(mine.canRequestRefund).toBe(false);
    // a second request while one is under way
    expect(
      (await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, { reason: 'FULL_FARE' }))
        .status,
    ).toBe(409);
  });

  it('refuses a driver, an unpaid ride, a non-ride ticket and client-chosen amounts', async () => {
    const w = await finishedRide(false);
    const t = await dispute(w, 'RIDE_PAYMENT');
    // not paid yet: nothing to refund
    const unpaid = await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, {
      reason: 'FULL_FARE',
    });
    expect(unpaid.status).toBe(409);
    expect(unpaid.body.error.code).toBe('PAYMENT_NOT_PAID');
    await api.post(`/api/v1/trips/${w.tripId}/payment/confirm`).set(auth(w.driver.accessToken));

    const driverTicket = (
      await post(w.driver.accessToken, '/tickets', {
        categoryCode: 'RIDE_FARE',
        subject: 'Fare',
        body: 'The passenger disputes the fare',
        tripId: w.tripId,
      })
    ).body.data;
    expect(
      (
        await post(w.driver.accessToken, `/tickets/${driverTicket.id}/refund`, {
          reason: 'FULL_FARE',
        })
      ).status,
    ).toBe(403);
    // the server decides the amount of a whole-fare refund: a body carrying its own is refused
    const extra = await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, {
      reason: 'FULL_FARE',
      amountNpr: 1,
      bogus: 1,
    });
    expect(extra.status).toBe(400);
    const tooMuch = await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, {
      reason: 'PARTIAL',
      amountNpr: 999_999,
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.code).toBe('INVALID_REFUND_AMOUNT');
    const noWaiting = await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, {
      reason: 'WAITING_CHARGE',
    });
    expect(noWaiting.status).toBe(400);

    const general = (
      await post(w.passenger.accessToken, '/tickets', {
        categoryCode: 'APP_PROBLEM',
        subject: 'App',
        body: 'The app crashed during the ride',
      })
    ).body.data;
    expect(
      (
        await post(w.passenger.accessToken, `/tickets/${general.id}/refund`, {
          reason: 'FULL_FARE',
        })
      ).status,
    ).toBe(409);
  });

  it('allows only one refund under way per payment, even under simultaneous requests', async () => {
    const w = await finishedRide();
    const t = await dispute(w);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        post(w.passenger.accessToken, `/tickets/${t.id}/refund`, { reason: 'FULL_FARE' }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await pool.query('SELECT count(*)::int AS n FROM refunds')).rows[0].n).toBe(1);
  });
});

describe('the refund lifecycle', () => {
  it('runs request to completion, tells the person, and never edits the payment', async () => {
    const w = await finishedRide();
    const t = await dispute(w);
    const before = await payment(w.tripId);
    const reqd = (
      await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, { reason: 'FULL_FARE' })
    ).body.data;
    const a = await admin();

    // the moves must go in order
    expect((await act(a.token, reqd.id, { to: 'COMPLETED' })).status).toBe(409);
    expect((await act(a.token, reqd.id, { to: 'APPROVED' })).status).toBe(409);
    expect((await act(a.token, reqd.id, { to: 'REVIEWING' })).status).toBe(200);
    expect(
      (await act(a.token, reqd.id, { to: 'APPROVED', note: 'Waiting charge was wrong' })).status,
    ).toBe(200);
    const noMethod = await act(a.token, reqd.id, { to: 'PROCESSING' });
    expect(noMethod.status).toBe(400);
    expect((await act(a.token, reqd.id, { to: 'PROCESSING', method: 'DRIVER_CASH' })).status).toBe(
      200,
    );
    const failed = await act(a.token, reqd.id, { to: 'FAILED' });
    expect(failed.status).toBe(400); // needs a reason
    expect(
      (await act(a.token, reqd.id, { to: 'FAILED', failedReason: 'Driver unreachable' })).status,
    ).toBe(200);
    expect((await act(a.token, reqd.id, { to: 'PROCESSING', method: 'DRIVER_CASH' })).status).toBe(
      200,
    ); // retried
    const done = await act(a.token, reqd.id, {
      to: 'COMPLETED',
      reference: 'Returned at the next ride',
    });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'COMPLETED', method: 'DRIVER_CASH' });
    expect(done.body.data.completedAt).not.toBeNull();
    // final: nothing moves it again
    for (const to of REFUND_STATES)
      expect((await act(a.token, reqd.id, { to })).status, to).toBe(409);

    // the payment row is untouched: the refunded amount is derived from refunds
    const after = await payment(w.tripId);
    expect(after).toEqual(before);
    const detail = (await api.get(`/api/v1/admin/support/tickets/${t.id}`).set(auth(a.token))).body
      .data;
    expect(detail.payment).toMatchObject({
      refundedNpr: before.amount_npr,
      quote: { remainingNpr: 0 },
    });

    // the person was told of the decision and of the money
    const notes = (
      await pool.query(
        `SELECT type, body FROM notifications WHERE user_id = $1 AND type LIKE 'SUPPORT_REFUND%' ORDER BY created_at`,
        [w.passengerId],
      )
    ).rows;
    expect(notes.map((x) => x.type)).toEqual([
      'SUPPORT_REFUND_DECISION',
      'SUPPORT_REFUND_COMPLETED',
    ]);
    expect(notes[1].body).toContain('has been paid back');
    // and nothing more can be refunded for this ride
    const again = await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, {
      reason: 'PARTIAL',
      amountNpr: 10,
    });
    expect(again.status).toBe(409);
    // every step is in the ticket history and the audit log
    const audit = (
      await pool.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE subject_type = 'refund' AND action = 'REFUND_STATUS_CHANGED'`,
      )
    ).rows[0].n;
    expect(audit).toBe(6); // reviewing, approved, processing, failed, processing, completed
  });

  it('rejects with a stated reason, tells the person, and frees the payment for another request', async () => {
    const w = await finishedRide();
    const t = await dispute(w);
    const reqd = (
      await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, { reason: 'FULL_FARE' })
    ).body.data;
    const a = await admin();
    expect((await act(a.token, reqd.id, { to: 'REJECTED' })).status).toBe(400);
    expect(
      (await act(a.token, reqd.id, { to: 'REJECTED', note: 'The fare matched the meter.' })).status,
    ).toBe(200);
    const notes = (
      await pool.query(
        `SELECT body FROM notifications WHERE user_id = $1 AND type = 'SUPPORT_REFUND_DECISION'`,
        [w.passengerId],
      )
    ).rows;
    expect(notes[0].body).toContain('was not approved');
    const mine = (await get(w.passenger.accessToken, `/tickets/${t.id}`)).body.data;
    expect(mine.canRequestRefund).toBe(true);
    expect(
      (
        await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, {
          reason: 'PARTIAL',
          amountNpr: 20,
        })
      ).status,
    ).toBe(201);
  });

  it('needs REFUNDS_MANAGE to decide, SUPPORT_MANAGE to raise, and a second person to approve', async () => {
    const w = await finishedRide();
    const t = await dispute(w);
    const support = await admin(['DISPUTES_MANAGE', 'SUPPORT_MANAGE']);
    const finance = await admin(['REFUNDS_MANAGE']);
    const both = await admin();
    // raising needs SUPPORT_MANAGE; REFUNDS_MANAGE alone cannot
    expect(
      (
        await adminPost(finance.token, `/tickets/${t.id}/refunds`, {
          reason: 'PARTIAL',
          amountNpr: 5,
        })
      ).status,
    ).toBe(403);
    const raised = await adminPost(both.token, `/tickets/${t.id}/refunds`, {
      reason: 'PARTIAL',
      amountNpr: 25,
      note: 'Goodwill',
    });
    expect(raised.status).toBe(201);
    expect(raised.body.data.amountNpr).toBe(25);
    // deciding needs REFUNDS_MANAGE
    expect((await act(support.token, raised.body.data.id, { to: 'REVIEWING' })).status).toBe(403);
    expect((await act(both.token, raised.body.data.id, { to: 'REVIEWING' })).status).toBe(200);
    // whoever raised it cannot approve it; another holder of the permission can
    const own = await act(both.token, raised.body.data.id, { to: 'APPROVED' });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('FOUR_EYES');
    expect((await act(finance.token, raised.body.data.id, { to: 'APPROVED' })).status).toBe(200);
  });

  it('blocks resolving or closing a ticket while a refund is still being handled', async () => {
    const w = await finishedRide();
    const t = await dispute(w);
    const reqd = (
      await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, { reason: 'FULL_FARE' })
    ).body.data;
    const a = await admin();
    const blocked = await adminPost(a.token, `/tickets/${t.id}/status`, {
      status: 'RESOLVED',
      resolution: 'Decided',
      outcome: 'UPHELD',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('REFUND_IN_PROGRESS');
    await act(a.token, reqd.id, { to: 'REJECTED', note: 'Not warranted' });
    expect(
      (
        await adminPost(a.token, `/tickets/${t.id}/status`, {
          status: 'RESOLVED',
          resolution: 'Decided',
          outcome: 'REJECTED',
        })
      ).status,
    ).toBe(200);
  });

  it('applies only one of two simultaneous decisions on a refund', async () => {
    const w = await finishedRide();
    const t = await dispute(w);
    const reqd = (
      await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, { reason: 'FULL_FARE' })
    ).body.data;
    const a = await admin();
    const b = await admin();
    const moves = await Promise.all([
      act(a.token, reqd.id, { to: 'REVIEWING' }),
      act(b.token, reqd.id, { to: 'REJECTED', note: 'Declined by B' }),
    ]);
    const row = (await pool.query('SELECT status FROM refunds WHERE id = $1', [reqd.id])).rows[0];
    // REQUESTED -> REVIEWING and REQUESTED -> REJECTED are both legal, but only one can run first;
    // REVIEWING -> REJECTED is also legal, so both may succeed in that order, never in the other.
    expect(moves.filter((m) => m.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(['REVIEWING', 'REJECTED']).toContain(row.status);
    if (moves[1].status === 200 && moves[0].status === 409) expect(row.status).toBe('REJECTED');
  });

  it('hides refund controls from admins who cannot decide', async () => {
    const w = await finishedRide();
    const t = await dispute(w);
    await post(w.passenger.accessToken, `/tickets/${t.id}/refund`, { reason: 'FULL_FARE' });
    const support = await admin(['DISPUTES_MANAGE', 'SUPPORT_MANAGE']);
    const finance = await admin();
    const seen = (await api.get(`/api/v1/admin/support/tickets/${t.id}`).set(auth(support.token)))
      .body.data;
    expect(seen.canDecideRefunds).toBe(false);
    expect(seen.refunds[0].allowedNext).toEqual([]);
    const decider = (
      await api.get(`/api/v1/admin/support/tickets/${t.id}`).set(auth(finance.token))
    ).body.data;
    expect(decider.canDecideRefunds).toBe(true);
    expect(decider.refunds[0].allowedNext).toEqual(['REVIEWING', 'REJECTED']);
    expect((await act(finance.token, 'not-a-uuid', { to: 'REVIEWING' })).status).toBe(400);
    expect(
      (
        await api
          .post('/api/v1/admin/support/refunds/' + seen.refunds[0].id + '/action')
          .send({ to: 'REVIEWING' })
      ).status,
    ).toBe(401);
  });
});
