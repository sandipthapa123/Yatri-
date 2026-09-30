import {
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  canTicketTransition,
  statusAfterReply,
  ticketStatesLeadingTo,
  type AdminPermission,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { refreshSettings } from '../modules/settings/settings.service';
import { sweepSupport } from '../modules/support/tickets.service';
import { FIXTURES, api, loginTestAdmin, onboardUser } from './helpers';
import { auth, finishedRide } from './rides';

let n = 0;
async function admin(permissions: AdminPermission[] = ['DISPUTES_MANAGE', 'SUPPORT_MANAGE']) {
  const email = `support-admin-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1', permissions);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  return { token, id: id as string };
}
const adminPost = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/admin/support${path}`).set(auth(token)).send(body);
const adminGet = (token: string, path: string) =>
  api.get(`/api/v1/admin/support${path}`).set(auth(token));
const post = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/support${path}`).set(auth(token)).send(body);
const get = (token: string, path: string) => api.get(`/api/v1/support${path}`).set(auth(token));

const general = (token: string, extra: object = {}) =>
  post(token, '/tickets', {
    categoryCode: 'APP_PROBLEM',
    subject: 'The map will not load',
    body: 'Since this morning the map stays blank.',
    ...extra,
  });
const notifications = async (userId: string, type: string) =>
  (
    await pool.query('SELECT body FROM notifications WHERE user_id = $1 AND type = $2', [
      userId,
      type,
    ])
  ).rows as Array<{ body: string }>;

describe('support state machine: one definition', () => {
  it('every reply outcome is a legal move, and the tables agree with each other', () => {
    for (const from of TICKET_STATUSES) {
      for (const actor of ['REQUESTER', 'ADMIN'] as const) {
        const to = statusAfterReply(from, actor);
        if (to === null) {
          expect(from).toBe('CLOSED');
        } else if (to !== from) {
          expect(canTicketTransition(from, to), `${actor} reply from ${from}`).toBe(true);
        }
      }
    }
    for (const to of TICKET_STATUSES) {
      for (const from of ticketStatesLeadingTo(to)) {
        expect(TICKET_TRANSITIONS[from]).toContain(to);
      }
    }
    expect(TICKET_TRANSITIONS.CLOSED).toEqual([]);
    for (const s of TICKET_STATUSES) expect(TICKET_TRANSITIONS[s]).not.toContain(s);
  });
});

describe('creating tickets', () => {
  it('lets a passenger and a driver raise a ticket from the configured categories', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    const cats = (await get(p.accessToken, '/categories')).body.data as Array<{ code: string }>;
    expect(cats.map((c) => c.code)).toContain('APP_PROBLEM');
    expect(cats.map((c) => c.code)).not.toContain('DRIVER_VERIFICATION'); // drivers only
    const driverCats = (await get(d.accessToken, '/categories')).body.data as Array<{
      code: string;
    }>;
    expect(driverCats.map((c) => c.code)).toContain('DRIVER_VERIFICATION');

    const t = await general(p.accessToken);
    expect(t.status).toBe(201);
    expect(t.body.data).toMatchObject({ status: 'OPEN', isDispute: false, tripId: null });
    expect(t.body.data.number).toBeGreaterThan(0);
    expect(t.body.data.statusText).toContain('received');
    expect((await general(d.accessToken)).status).toBe(201);
    expect(await notifications(p.user.id as string, 'SUPPORT_TICKET_CREATED')).toHaveLength(1);
  });

  it('validates: unknown, role-restricted, inactive categories and short text', async () => {
    const p = await onboardUser('PASSENGER');
    expect((await general(p.accessToken, { categoryCode: 'NOPE' })).status).toBe(400);
    expect((await general(p.accessToken, { categoryCode: 'DRIVER_VERIFICATION' })).status).toBe(
      400,
    );
    expect((await general(p.accessToken, { body: 'short' })).status).toBe(400);
    expect((await general(p.accessToken, { subject: '' })).status).toBe(400);
    await pool.query("UPDATE support_categories SET is_active = false WHERE code = 'FEEDBACK'");
    try {
      expect((await general(p.accessToken, { categoryCode: 'FEEDBACK' })).status).toBe(400);
    } finally {
      await pool.query("UPDATE support_categories SET is_active = true WHERE code = 'FEEDBACK'");
    }
  });

  it('requires authentication and a person role', async () => {
    expect((await api.get('/api/v1/support/tickets')).status).toBe(401);
    const a = await admin();
    expect((await get(a.token, '/tickets')).status).toBe(403);
  });

  it('names the ride for ride problems, references it, and never copies it', async () => {
    const w = await finishedRide();
    const noRide = await post(w.passenger.accessToken, '/tickets', {
      categoryCode: 'RIDE_FARE',
      subject: 'Fare',
      body: 'The fare was higher than expected',
    });
    expect(noRide.status).toBe(400);
    const t = await post(w.passenger.accessToken, '/tickets', {
      categoryCode: 'RIDE_FARE',
      subject: 'Fare',
      body: 'The fare was higher than expected',
      tripId: w.tripId,
    });
    expect(t.status).toBe(201);
    expect(t.body.data).toMatchObject({ isDispute: true, tripId: w.tripId });
    const cols = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'support_tickets'`,
      )
    ).rows.map((r) => r.column_name as string);
    // a reference to the ride, none of its facts
    expect(cols).toContain('trip_id');
    for (const copied of ['fare_npr', 'pickup', 'destination', 'driver_id', 'amount_npr']) {
      expect(cols).not.toContain(copied);
    }
    // a passenger cannot pick the passenger-behaviour category; the driver can
    const behaviour = {
      categoryCode: 'RIDE_PASSENGER_BEHAVIOUR',
      subject: 'Behaviour',
      body: 'Something happened on the ride',
      tripId: w.tripId,
    };
    expect((await post(w.passenger.accessToken, '/tickets', behaviour)).status).toBe(400);
    expect((await post(w.driver.accessToken, '/tickets', behaviour)).status).toBe(201);
  });

  it('allows one open problem per person per ride, even under simultaneous requests', async () => {
    const w = await finishedRide(false);
    const open = () =>
      post(w.passenger.accessToken, '/tickets', {
        categoryCode: 'RIDE_ROUTE',
        subject: 'Route',
        body: 'The driver took a longer route',
        tripId: w.tripId,
      });
    const results = await Promise.all([open(), open(), open()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('keeps strangers out of rides, and other people out of your tickets', async () => {
    const w = await finishedRide(false);
    const stranger = await onboardUser('PASSENGER');
    expect(
      (
        await post(stranger.accessToken, '/tickets', {
          categoryCode: 'RIDE_FARE',
          subject: 'Fare',
          body: 'Not even my ride at all',
          tripId: w.tripId,
        })
      ).status,
    ).toBe(404);
    const t = (await general(w.passenger.accessToken)).body.data;
    expect((await get(stranger.accessToken, `/tickets/${t.id}`)).status).toBe(404);
    expect(
      (await post(stranger.accessToken, `/tickets/${t.id}/replies`, { body: 'hi' })).status,
    ).toBe(404);
    expect((await get(stranger.accessToken, '/tickets')).body.data).toEqual([]);
  });
});

describe('conversation and lifecycle', () => {
  it('runs the whole lifecycle with replies, notifications and only legal moves', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken)).body.data;

    const asked = await adminPost(a.token, `/tickets/${t.id}/reply`, {
      body: 'Which phone are you using?',
    });
    expect(asked.status).toBe(200);
    expect(asked.body.data.status).toBe('WAITING_FOR_USER');
    expect(asked.body.data.assignedToId).toBe(a.id);
    expect((await notifications(p.user.id as string, 'SUPPORT_REPLY')).length).toBe(1);
    const mine = (await get(p.accessToken, `/tickets/${t.id}`)).body.data;
    expect(mine.status).toBe('WAITING_FOR_USER');
    expect(mine.statusText).toContain('we need something from you');
    expect(mine.messages.map((m: { from: string }) => m.from)).toEqual(['YOU', 'SUPPORT']);

    const answered = await post(p.accessToken, `/tickets/${t.id}/replies`, {
      body: 'An Android phone.',
    });
    expect(answered.body.data.status).toBe('WAITING_FOR_ADMIN');

    expect(
      (await adminPost(a.token, `/tickets/${t.id}/status`, { status: 'RESOLVED' })).status,
    ).toBe(400);
    const resolved = await adminPost(a.token, `/tickets/${t.id}/status`, {
      status: 'RESOLVED',
      resolution: 'Fixed in the latest version.',
    });
    expect(resolved.body.data.status).toBe('RESOLVED');
    expect((await notifications(p.user.id as string, 'SUPPORT_STATUS')).length).toBe(1);
    const afterResolve = (await get(p.accessToken, `/tickets/${t.id}`)).body.data;
    expect(afterResolve).toMatchObject({
      resolution: 'Fixed in the latest version.',
      canClose: true,
    });

    const reopened = await post(p.accessToken, `/tickets/${t.id}/replies`, {
      body: 'Still broken, sorry.',
    });
    expect(reopened.body.data).toMatchObject({ status: 'WAITING_FOR_ADMIN', resolution: null });
    await adminPost(a.token, `/tickets/${t.id}/status`, {
      status: 'RESOLVED',
      resolution: 'Reset your cache, please.',
    });
    const closed = await post(p.accessToken, `/tickets/${t.id}/close`);
    expect(closed.body.data.status).toBe('CLOSED');
    expect(
      (await post(p.accessToken, `/tickets/${t.id}/replies`, { body: 'One more thing' })).status,
    ).toBe(409);
    expect((await post(p.accessToken, `/tickets/${t.id}/close`)).status).toBe(409);
  });

  it('refuses illegal transitions and says what is possible', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken)).body.data;
    const closed = await adminPost(a.token, `/tickets/${t.id}/status`, { status: 'CLOSED' });
    expect(closed.status).toBe(200);
    for (const status of TICKET_STATUSES) {
      const r = await adminPost(a.token, `/tickets/${t.id}/status`, {
        status,
        resolution: 'Nothing more',
      });
      expect(r.status, status).toBe(409);
      expect(r.body.error.code).toBe('INVALID_TICKET_TRANSITION');
    }
    const t2 = (await general(p.accessToken)).body.data;
    const same = await adminPost(a.token, `/tickets/${t2.id}/status`, { status: 'OPEN' });
    expect(same.status).toBe(409);
    expect(same.body.error.message).toContain('can only become');
    expect((await post(p.accessToken, `/tickets/${t2.id}/close`)).status).toBe(409);
  });

  it('applies conflicting simultaneous moves one after the other, never both', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const b = await admin();
    const t = (await general(p.accessToken)).body.data;
    await adminPost(a.token, `/tickets/${t.id}/status`, { status: 'IN_REVIEW' });
    const moves = await Promise.all([
      adminPost(a.token, `/tickets/${t.id}/status`, {
        status: 'RESOLVED',
        resolution: 'Decided by admin A',
      }),
      adminPost(b.token, `/tickets/${t.id}/status`, { status: 'CLOSED' }),
    ]);
    const row = (await pool.query('SELECT status FROM support_tickets WHERE id = $1', [t.id]))
      .rows[0];
    // RESOLVED then CLOSED is legal; CLOSED then RESOLVED is not: so CLOSED always wins the end state.
    expect(moves.filter((m) => m.status === 200).length).toBeGreaterThanOrEqual(1);
    if (moves[0].status === 409) expect(row.status).toBe('CLOSED');
    expect(['RESOLVED', 'CLOSED']).toContain(row.status);
    const resolutions = (
      await pool.query(
        `SELECT count(*)::int AS n FROM support_messages WHERE ticket_id = $1 AND kind = 'RESOLUTION'`,
        [t.id],
      )
    ).rows[0].n as number;
    expect(resolutions).toBe(moves[0].status === 200 ? 1 : 0);
  });

  it('keeps internal notes away from the person and sends nothing for them', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken)).body.data;
    const before = (await notifications(p.user.id as string, 'SUPPORT_REPLY')).length;
    const note = await adminPost(a.token, `/tickets/${t.id}/notes`, {
      body: 'Looks like a known bug, SECRET-NOTE',
    });
    expect(note.status).toBe(200);
    const mine = JSON.stringify((await get(p.accessToken, `/tickets/${t.id}`)).body);
    expect(mine).not.toContain('SECRET-NOTE');
    expect((await notifications(p.user.id as string, 'SUPPORT_REPLY')).length).toBe(before);
    const detail = (await adminGet(a.token, `/tickets/${t.id}`)).body.data;
    expect(detail.messages.some((m: { kind: string }) => m.kind === 'NOTE')).toBe(true);
  });
});

describe('the admin workspace', () => {
  it('filters, searches, prioritises and assigns; priority comes from data', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken, { subject: 'Zebra crossing problem' })).body.data;
    const other = (
      await general(p.accessToken, { categoryCode: 'FEEDBACK', subject: 'A nice idea' })
    ).body.data;
    const list = async (q: string) =>
      (await adminGet(a.token, `/tickets${q}`)).body.data.items.map(
        (i: { id: string }) => i.id,
      ) as string[];
    expect(await list('?search=zebra')).toEqual([t.id]);
    expect(await list(`?search=${t.number}`)).toEqual([t.id]);
    expect(await list('?category=FEEDBACK')).toEqual([other.id]);
    expect(await list('?kind=dispute')).toEqual([]);
    expect(await list('?assigned=none')).toHaveLength(2);

    expect(
      (
        await adminPost(a.token, `/tickets/${t.id}/priority`, {
          priorityCode: 'URGENT',
          reason: 'Blocks work',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await adminPost(a.token, `/tickets/${t.id}/priority`, {
          priorityCode: 'BOGUS',
          reason: 'nope nope',
        })
      ).status,
    ).toBe(400);
    expect((await list(''))[0]).toBe(t.id); // urgent first
    expect(await list('?priority=LOW')).toEqual([other.id]);

    expect((await adminPost(a.token, `/tickets/${t.id}/assign`, { adminId: a.id })).status).toBe(
      200,
    );
    expect(await list('?assigned=me')).toEqual([t.id]);
    const stranger = await onboardUser('PASSENGER');
    expect(
      (await adminPost(a.token, `/tickets/${t.id}/assign`, { adminId: stranger.user.id })).status,
    ).toBe(400);
    const noRights = await admin(['OPERATIONS_VIEW']);
    expect(
      (await adminPost(a.token, `/tickets/${t.id}/assign`, { adminId: noRights.id })).status,
    ).toBe(400);
    expect((await adminPost(a.token, `/tickets/${t.id}/assign`, { adminId: null })).status).toBe(
      200,
    );
    expect(await list('?assigned=none')).toContain(t.id);
    const page = (await adminGet(a.token, '/tickets?pageSize=1&page=2')).body.data;
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  it('shows ride, payment, history and audit context, and records the view', async () => {
    const w = await finishedRide();
    const a = await admin();
    await general(w.passenger.accessToken); // an earlier ticket, for the history
    const t = (
      await post(w.passenger.accessToken, '/tickets', {
        categoryCode: 'RIDE_PAYMENT',
        subject: 'Payment',
        body: 'The driver asked for more cash',
        tripId: w.tripId,
      })
    ).body.data;
    const detail = (await adminGet(a.token, `/tickets/${t.id}`)).body.data;
    expect(detail.ride).toMatchObject({ tripId: w.tripId, status: 'COMPLETED' });
    expect(detail.ride.fareFinalNpr).toBeGreaterThan(0);
    expect(detail.payment).toMatchObject({ status: 'PAID', refundedNpr: 0 });
    expect(detail.payment.quote.remainingNpr).toBe(detail.payment.amountNpr);
    expect(detail.history).toHaveLength(1);
    expect(detail.allowedNext).toEqual(TICKET_TRANSITIONS.OPEN);
    const views = await pool.query(
      `SELECT 1 FROM audit_log WHERE actor_id = $1 AND action = 'VIEW_SUPPORT_TICKET' AND subject_id = $2`,
      [a.id, t.id],
    );
    expect(views.rowCount).toBe(1);
    const status = await adminPost(a.token, `/tickets/${t.id}/status`, { status: 'IN_REVIEW' });
    expect(status.body.data.audit.map((e: { action: string }) => e.action)).toContain(
      'TICKET_STATUS_CHANGED',
    );
    const noOutcome = await adminPost(a.token, `/tickets/${t.id}/status`, {
      status: 'RESOLVED',
      resolution: 'Explained',
    });
    expect(noOutcome.status).toBe(400); // a dispute needs an outcome
    const done = await adminPost(a.token, `/tickets/${t.id}/status`, {
      status: 'RESOLVED',
      resolution: 'Explained the charge',
      outcome: 'REJECTED',
    });
    expect(done.body.data.outcome).toBe('REJECTED');
    expect((await notifications(w.passengerId, 'SUPPORT_DISPUTE_UPDATED')).length).toBe(2); // in review, then resolved
    const mine = (await get(w.passenger.accessToken, `/tickets/${t.id}`)).body.data;
    expect(mine).toMatchObject({ outcome: 'REJECTED', resolution: 'Explained the charge' });
  });

  it('follows RBAC: disputes with DISPUTES_MANAGE, general tickets with SUPPORT_MANAGE', async () => {
    const w = await finishedRide(false);
    const generalTicket = (await general(w.passenger.accessToken)).body.data;
    const dispute = (
      await post(w.passenger.accessToken, '/tickets', {
        categoryCode: 'RIDE_OTHER',
        subject: 'Other',
        body: 'Something else went wrong',
        tripId: w.tripId,
      })
    ).body.data;
    const disputesOnly = await admin(['DISPUTES_MANAGE']);
    const list = (await adminGet(disputesOnly.token, '/tickets')).body.data;
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([dispute.id]);
    expect((await adminGet(disputesOnly.token, `/tickets/${generalTicket.id}`)).status).toBe(404);
    expect((await adminGet(disputesOnly.token, `/tickets/${dispute.id}`)).status).toBe(200);
    expect(
      (await adminPost(disputesOnly.token, `/tickets/${generalTicket.id}/reply`, { body: 'hello' }))
        .status,
    ).toBe(404);
    const nothing = await admin(['OPERATIONS_VIEW']);
    expect((await adminGet(nothing.token, '/tickets')).status).toBe(403);
    expect(
      (await adminPost(nothing.token, `/tickets/${dispute.id}/notes`, { body: 'x' })).status,
    ).toBe(403);
    expect((await api.get('/api/v1/admin/support/tickets')).status).toBe(401);
  });

  it('edits categories and priorities as audited data, with reasons', async () => {
    const a = await admin(['SETTINGS_MANAGE']);
    const viewer = await admin(['SETTINGS_VIEW']);
    const p = await onboardUser('PASSENGER');
    const cfg = (await adminGet(viewer.token, '/config')).body.data;
    expect(cfg.priorities.map((x: { code: string }) => x.code)).toEqual([
      'URGENT',
      'HIGH',
      'NORMAL',
      'LOW',
    ]);
    const patch = (token: string, path: string, body: object) =>
      api.patch(`/api/v1/admin/support${path}`).set(auth(token)).send(body);
    expect(
      (await patch(viewer.token, '/categories/OTHER', { label: 'Misc', reason: 'rename it' }))
        .status,
    ).toBe(403);
    expect((await patch(a.token, '/categories/OTHER', { label: 'Misc' })).status).toBe(400);
    try {
      const r = await patch(a.token, '/categories/OTHER', {
        label: 'Miscellaneous',
        reason: 'clearer name',
      });
      expect(r.body.data.label).toBe('Miscellaneous');
      const cats = (await get(p.accessToken, '/categories')).body.data as Array<{
        code: string;
        label: string;
      }>;
      expect(cats.find((c) => c.code === 'OTHER')?.label).toBe('Miscellaneous');
      expect(
        (await patch(a.token, '/categories/RIDE_FARE', { requiresRide: false, reason: 'try it' }))
          .status,
      ).toBe(400);
      expect(
        (await patch(a.token, '/priorities/HIGH', { escalatesTo: 'LOW', reason: 'backwards' }))
          .status,
      ).toBe(400);
      const pr = await patch(a.token, '/priorities/LOW', {
        firstResponseHours: 96,
        reason: 'fewer low tickets',
      });
      expect(pr.body.data.firstResponseHours).toBe(96);
    } finally {
      await pool.query(
        "UPDATE support_categories SET label = 'Something else' WHERE code = 'OTHER'",
      );
      await pool.query(
        "UPDATE support_priorities SET first_response_hours = 72 WHERE code = 'LOW'",
      );
    }
    const audited = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action IN ('SUPPORT_CATEGORY_UPDATED', 'SUPPORT_PRIORITY_UPDATED')`,
    );
    expect(audited.rows[0].n).toBe(2);
  });
});

describe('escalation and auto-close', () => {
  it('escalates an unanswered ticket once per wait, by the priority rule', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken)).body.data;
    await pool.query(
      `UPDATE support_tickets SET updated_at = now() - interval '25 hours' WHERE id = $1`,
      [t.id],
    );
    expect((await sweepSupport()).escalated).toBe(1);
    const row = (
      await pool.query('SELECT priority, escalation_level FROM support_tickets WHERE id = $1', [
        t.id,
      ])
    ).rows[0];
    expect(row).toMatchObject({ priority: 'HIGH', escalation_level: 1 });
    expect((await sweepSupport()).escalated).toBe(0); // once per wait
    const detail = (await adminGet(a.token, `/tickets/${t.id}`)).body.data;
    expect(detail.escalationLevel).toBe(1);
    const teamNotes = await notifications(a.id, 'SUPPORT_ESCALATED');
    expect(teamNotes.length).toBe(1);
    expect(teamNotes[0]?.body).not.toContain('map'); // says that, not what
    expect(await notifications(p.user.id as string, 'SUPPORT_ESCALATED')).toHaveLength(0);
    // a fresh reply from the person starts a new wait
    await post(p.accessToken, `/tickets/${t.id}/replies`, { body: 'Any news on this please?' });
    await pool.query(
      `UPDATE support_tickets SET updated_at = now() - interval '9 hours',
         escalated_at = now() - interval '30 hours' WHERE id = $1`,
      [t.id],
    );
    expect((await sweepSupport()).escalated).toBe(1);
    const due = (await adminGet(a.token, '/tickets?overdue=true')).body.data.items;
    expect(due.every((i: { overdue: boolean }) => i.overdue)).toBe(true);
  });

  it('does not escalate what is waiting on the person', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken)).body.data;
    await adminPost(a.token, `/tickets/${t.id}/reply`, { body: 'Can you tell me more?' });
    await pool.query(
      `UPDATE support_tickets SET updated_at = now() - interval '90 hours' WHERE id = $1`,
      [t.id],
    );
    expect((await sweepSupport()).escalated).toBe(0);
  });

  it('closes resolved tickets after the configured days, and only those', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken)).body.data;
    const live = (await general(p.accessToken)).body.data;
    await adminPost(a.token, `/tickets/${t.id}/status`, {
      status: 'RESOLVED',
      resolution: 'All done here.',
    });
    await pool.query(
      `UPDATE support_tickets SET resolved_at = now() - interval '8 days' WHERE id = $1`,
      [t.id],
    );
    expect((await sweepSupport()).closed).toBe(1);
    const status = async (id: string) =>
      (await pool.query('SELECT status FROM support_tickets WHERE id = $1', [id])).rows[0].status;
    expect(await status(t.id)).toBe('CLOSED');
    expect(await status(live.id)).toBe('OPEN');
    const told = await notifications(p.user.id as string, 'SUPPORT_STATUS');
    expect(told.some((x) => x.body.includes('closed'))).toBe(true);
  });
});

describe('evidence uploads', () => {
  const attach = (token: string, id: string, file: Buffer, name: string, body?: string) => {
    let r = api.post(`/api/v1/support/tickets/${id}/attachments`).set(auth(token));
    if (body) r = r.field('body', body);
    return r.attach('file', file, name);
  };

  it('stores permitted files privately, checks the real type, and serves them to the right people', async () => {
    const p = await onboardUser('PASSENGER');
    const other = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken)).body.data;

    const bad = await attach(p.accessToken, t.id, FIXTURES.invalid, 'photo.jpg');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_FILE_TYPE');

    const ok = await attach(
      p.accessToken,
      t.id,
      FIXTURES.png,
      'screenshot.png',
      'Here is what I see',
    );
    expect(ok.status).toBe(201);
    const last = ok.body.data.messages.at(-1);
    expect(last.body).toBe('Here is what I see');
    const file = last.attachments[0];
    expect(file).toMatchObject({ filename: 'screenshot.png', contentType: 'image/png' });
    expect(JSON.stringify(ok.body)).not.toContain('storage_key');
    expect((await attach(p.accessToken, t.id, FIXTURES.pdf, 'receipt.pdf')).status).toBe(201);

    const row = (
      await pool.query('SELECT storage_key FROM support_attachments WHERE id = $1', [file.id])
    ).rows[0];
    expect(row.storage_key).not.toContain('screenshot'); // random key, never the person's filename

    const url = await get(p.accessToken, `/attachments/${file.id}/download-url`);
    expect(url.status).toBe(200);
    expect(url.body.data.expiresInSeconds).toBeGreaterThan(0);
    expect((await get(other.accessToken, `/attachments/${file.id}/download-url`)).status).toBe(404);
    expect((await api.get(`/api/v1/support/attachments/${file.id}/download-url`)).status).toBe(401);
    const adminUrl = await adminGet(a.token, `/attachments/${file.id}/download-url`);
    expect(adminUrl.status).toBe(200);
    const audited = await pool.query(
      `SELECT 1 FROM audit_log WHERE action = 'VIEW_SUPPORT_ATTACHMENT' AND actor_id = $1`,
      [a.id],
    );
    expect(audited.rowCount).toBe(1);
    const nobody = await admin(['OPERATIONS_VIEW']);
    expect((await adminGet(nobody.token, `/attachments/${file.id}/download-url`)).status).toBe(403);
  });

  it('caps files per ticket by the setting and refuses uploads on closed tickets', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken)).body.data;
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('SUPPORT_MAX_ATTACHMENTS_PER_TICKET', '2'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = '2'::jsonb`,
    );
    try {
      await refreshSettings();
      expect((await attach(p.accessToken, t.id, FIXTURES.jpeg, 'a.jpg')).status).toBe(201);
      expect((await attach(p.accessToken, t.id, FIXTURES.jpeg, 'b.jpg')).status).toBe(201);
      const third = await attach(p.accessToken, t.id, FIXTURES.jpeg, 'c.jpg');
      expect(third.status).toBe(409);
      expect(third.body.error.code).toBe('TOO_MANY_ATTACHMENTS');
      expect((await get(p.accessToken, `/tickets/${t.id}`)).body.data.attachmentsLeft).toBe(0);
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM support_attachments')).rows[0].n,
      ).toBe(2);
    } finally {
      await pool.query(
        `DELETE FROM platform_settings WHERE key = 'SUPPORT_MAX_ATTACHMENTS_PER_TICKET'`,
      );
      await refreshSettings();
    }
    await adminPost(a.token, `/tickets/${t.id}/status`, { status: 'CLOSED' });
    expect((await attach(p.accessToken, t.id, FIXTURES.jpeg, 'late.jpg')).status).toBe(409);
  });

  it('lets support attach a file and shows it to the person', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await admin();
    const t = (await general(p.accessToken)).body.data;
    const r = await api
      .post(`/api/v1/admin/support/tickets/${t.id}/attachments`)
      .set(auth(a.token))
      .field('body', 'Here is the guide')
      .attach('file', FIXTURES.pdf, 'guide.pdf');
    expect(r.status).toBe(201);
    const mine = (await get(p.accessToken, `/tickets/${t.id}`)).body.data;
    expect(mine.messages.at(-1)).toMatchObject({ from: 'SUPPORT', body: 'Here is the guide' });
    expect(mine.messages.at(-1).attachments[0].filename).toBe('guide.pdf');
  });
});

describe('sensitive data', () => {
  it('never shows the person admin-only fields', async () => {
    const p = await onboardUser('PASSENGER');
    const t = (await general(p.accessToken)).body.data;
    const body = JSON.stringify((await get(p.accessToken, `/tickets/${t.id}`)).body);
    for (const secret of ['assigned', 'priority', 'escalation', 'admin_permissions', 'password']) {
      expect(body).not.toContain(secret);
    }
    const list = JSON.stringify((await get(p.accessToken, '/tickets')).body);
    expect(list).not.toContain('requester');
  });
});
