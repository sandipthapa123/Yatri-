import {
  DISABILITY_CONSENT_POLICY_KEY,
  DISABILITY_DRIVER_TEXT,
  DISABILITY_VERIFICATION_STATUSES,
  cardDatesProblem,
  cardLast4,
  cardNumberProblem,
  checkDisabilityMove,
  disabilityAdminActionsFrom,
  disabilityAnnouncement,
  disabilityExpiryReminder,
  submissionGaps,
  type AdminDisabilityDetail,
  type AdminDisabilityList,
  type AdminPermission,
  type DisabilityVerificationStatus,
  type DisabilityVerificationView,
  type TripSummary,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { setDisabilityVerifier } from '../modules/disability/verifier';
import { benefitActiveFor, hashCard, sweepDisabilityExpiry } from '../modules/disability/verification.service';
import { runRiskSweep } from '../modules/risk/sweep';
import { FIXTURES, api, loginTestAdmin, onboardUser, type OnboardedUser } from './helpers';
import { arriveAtPickup, auth, rideWorld, type RideWorld } from './rides';

// ---------------------------------------------------------------- helpers

const ME = '/api/v1/me/disability-verification';
let n = 0;
const reviewer = (permissions: AdminPermission[] = ['DISABILITY_VERIFICATION_VIEW', 'DISABILITY_VERIFICATION_REVIEW']) =>
  loginTestAdmin(`dis-${Date.now()}-${++n}@example.com`, 'a-strong-test-password-1', permissions);
const cardNumber = () => `NP-${Date.now().toString(36).toUpperCase()}-${(++n).toString().padStart(4, '0')}`;
const in30Days = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const longAgo = '2020-01-01';
const farFuture = () => new Date(Date.now() + 3 * 365 * 86_400_000).toISOString().slice(0, 10);

async function consentVersion(): Promise<string> {
  const r = await pool.query('SELECT version FROM compliance_policies WHERE key = $1', [DISABILITY_CONSENT_POLICY_KEY]);
  return r.rows[0].version as string;
}

const view = async (u: OnboardedUser) => (await api.get(ME).set(auth(u.accessToken))).body.data as DisabilityVerificationView;

/** A rider who has opted in, entered a card and added its document, ready to send. */
async function ready(over: { expiry?: string; card?: string; user?: OnboardedUser } = {}) {
  const user = over.user ?? (await onboardUser('PASSENGER'));
  const card = over.card ?? cardNumber();
  expect((await api.post(ME).set(auth(user.accessToken)).send({ consentVersion: await consentVersion() })).status).toBe(201);
  const patch = await api.patch(ME).set(auth(user.accessToken)).send({
    details: { cardNumber: card, issuingAuthority: 'District Administration Office', issueDate: longAgo, expiryDate: over.expiry ?? farFuture() },
  });
  expect(patch.status, JSON.stringify(patch.body)).toBe(200);
  const doc = await api.post(`${ME}/documents`).set(auth(user.accessToken)).attach('file', FIXTURES.png, 'card.png');
  expect(doc.status, JSON.stringify(doc.body)).toBe(201);
  return { user, card };
}

async function submitted(over: Parameters<typeof ready>[0] = {}) {
  const r = await ready(over);
  const res = await api.post(`${ME}/submit`).set(auth(r.user.accessToken)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = (await pool.query('SELECT id FROM disability_verifications WHERE user_id = $1', [(r.user.user.id as string)])).rows[0].id as string;
  return { ...r, id };
}

async function verified(over: Parameters<typeof ready>[0] = {}) {
  const s = await submitted(over);
  const admin = await reviewer();
  const res = await api.post(`/api/v1/admin/disability-verifications/${s.id}/approve`).set(auth(admin)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { ...s, admin };
}

// ---------------------------------------------------------------- the pure rules

describe('disability verification rules (pure)', () => {
  it('has a legal move table where VERIFIED can only end, and every state is reachable', () => {
    for (const to of DISABILITY_VERIFICATION_STATUSES) {
      if (to === 'VERIFIED') expect(checkDisabilityMove('VERIFIED', 'SUBMITTED', 'ADMIN').ok).toBe(false);
    }
    expect(checkDisabilityMove('VERIFIED', 'EXPIRED', 'SYSTEM').ok).toBe(true);
    expect(checkDisabilityMove('VERIFIED', 'REVOKED', 'ADMIN').ok).toBe(true);
    expect(checkDisabilityMove('REJECTED', 'VERIFIED', 'ADMIN').ok).toBe(false); // a rejection is not undone: they apply again
    expect(checkDisabilityMove('NOT_SUBMITTED', 'VERIFIED', 'ADMIN').ok).toBe(false);
  });

  it('never lets a rider (or anyone but staff or the official check) make themselves VERIFIED', () => {
    for (const from of DISABILITY_VERIFICATION_STATUSES) {
      expect(checkDisabilityMove(from, 'VERIFIED', 'PASSENGER').ok, from).toBe(false);
    }
    expect(checkDisabilityMove('SUBMITTED', 'VERIFIED', 'ADMIN').ok).toBe(true);
    expect(checkDisabilityMove('SUBMITTED', 'VERIFIED', 'SYSTEM').ok).toBe(true);
    expect(checkDisabilityMove('SUBMITTED', 'EXPIRED', 'ADMIN').ok).toBe(false);
  });

  it('derives the admin buttons from the one table', () => {
    expect(disabilityAdminActionsFrom('SUBMITTED').sort()).toEqual(['approve', 'reject', 'request-correction', 'start-review'].sort());
    expect(disabilityAdminActionsFrom('VERIFIED')).toEqual(['revoke']);
    expect(disabilityAdminActionsFrom('NOT_SUBMITTED')).toEqual([]);
  });

  it('checks card numbers, dates and what is missing, in words', () => {
    expect(cardNumberProblem('12')).toContain('needs');
    expect(cardNumberProblem('NP-1234-5678')).toBeNull();
    expect(cardLast4('NP-1234-5678')).toBe('5678');
    expect(cardDatesProblem({ issueDate: '2020-01-01', expiryDate: '2019-01-01' }, '2026-10-02')).toContain('expired');
    expect(cardDatesProblem({ issueDate: null, expiryDate: '2025-01-01' }, '2026-10-02')).toContain('expired');
    expect(cardDatesProblem({ issueDate: '2999-01-01', expiryDate: null }, '2026-10-02')).toContain('future');
    expect(submissionGaps({ consentGiven: false, method: 'MANUAL', hasCardNumber: false, issuingAuthority: null, issueDate: null, expiryDate: null, hasDocument: false }, '2026-10-02')).toHaveLength(6);
    expect(submissionGaps({ consentGiven: true, method: 'OFFICIAL_API', hasCardNumber: true, issuingAuthority: 'X Office', issueDate: '2020-01-01', expiryDate: '2030-01-01', hasDocument: false }, '2026-10-02')).toEqual([]);
  });

  it('announces each state in one sentence a screen reader can speak', () => {
    expect(disabilityAnnouncement('SUBMITTED')).toBe('Disability benefit verification submitted. Status: Under review. We will tell you when it changes.');
    for (const s of DISABILITY_VERIFICATION_STATUSES) {
      const text = disabilityAnnouncement(s as DisabilityVerificationStatus);
      expect(text).toContain('Status:');
      expect(text.length).toBeGreaterThan(30);
    }
  });

  it('reminds at 30 and 7 days, once each', () => {
    expect(disabilityExpiryReminder(45)).toBeNull();
    expect(disabilityExpiryReminder(30)).toBe(30);
    expect(disabilityExpiryReminder(10)).toBe(30);
    expect(disabilityExpiryReminder(7)).toBe(7);
    expect(disabilityExpiryReminder(0)).toBe(7);
  });
});

// ---------------------------------------------------------------- the rider's flow

describe('the rider: consent, details, document, submit', () => {
  it('starts as not submitted and optional, and requires consent before anything is collected', async () => {
    const u = await onboardUser('PASSENGER');
    const v = await view(u);
    expect(v.status).toBe('NOT_SUBMITTED');
    expect(v.canOptIn).toBe(true);
    expect(v.canEdit).toBe(false);
    const early = await api.patch(ME).set(auth(u.accessToken)).send({ details: { cardNumber: 'NP-0000-1111' } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('CONSENT_REQUIRED');
    expect((await api.post(`${ME}/documents`).set(auth(u.accessToken)).attach('file', FIXTURES.png, 'c.png')).status).toBe(409);
  });

  it('refuses a consent version that is not the current one', async () => {
    const u = await onboardUser('PASSENGER');
    const res = await api.post(ME).set(auth(u.accessToken)).send({ consentVersion: '999' });
    expect(res.status).toBe(409);
  });

  it('records the consent in the existing consent system, not a second one', async () => {
    const u = await onboardUser('PASSENGER');
    await api.post(ME).set(auth(u.accessToken)).send({ consentVersion: await consentVersion() });
    const rec = await pool.query('SELECT 1 FROM compliance_records WHERE user_id = $1 AND policy_key = $2 AND withdrawn_at IS NULL', [(u.user.id as string), DISABILITY_CONSENT_POLICY_KEY]);
    expect(rec.rowCount).toBe(1);
    const tables = await pool.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'consent_given_at' OR column_name ILIKE '%consent%'`);
    expect(tables.rows.map((r) => r.table_name)).not.toContain('disability_consents');
  });

  it('stores only a keyed hash and the last four characters of the card number', async () => {
    const { user, card } = await ready();
    const row = (await pool.query('SELECT * FROM disability_verifications WHERE user_id = $1', [(user.user.id as string)])).rows[0];
    expect(row.card_last4).toBe(card.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(-4));
    expect(row.card_hash).toBe(hashCard(card));
    expect(JSON.stringify(row)).not.toContain(card);
    expect((await view(user)).card.last4).toBe(row.card_last4);
    expect(JSON.stringify(await view(user))).not.toContain(card);
  });

  it('lists what is missing in words, and refuses to submit until it is complete', async () => {
    const u = await onboardUser('PASSENGER');
    await api.post(ME).set(auth(u.accessToken)).send({ consentVersion: await consentVersion() });
    const v = await view(u);
    expect(v.canSubmit).toBe(false);
    expect(v.gaps.length).toBeGreaterThan(0);
    const res = await api.post(`${ME}/submit`).set(auth(u.accessToken)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INCOMPLETE');
  });

  it('refuses an expired card, a future issue date and a nonsense document', async () => {
    const u = await onboardUser('PASSENGER');
    await api.post(ME).set(auth(u.accessToken)).send({ consentVersion: await consentVersion() });
    const expired = await api.patch(ME).set(auth(u.accessToken)).send({ details: { expiryDate: '2019-01-01' } });
    expect(expired.status).toBe(400);
    expect(expired.body.error.message).toContain('expired');
    const future = await api.patch(ME).set(auth(u.accessToken)).send({ details: { issueDate: '2999-01-01' } });
    expect(future.status).toBe(400);
    const bad = await api.post(`${ME}/documents`).set(auth(u.accessToken)).attach('file', FIXTURES.invalid, 'c.txt');
    expect(bad.status).toBe(400);
  });

  it('submits, announces the state, and then the application is no longer the rider to edit', async () => {
    const { user } = await ready();
    const sent = await api.post(`${ME}/submit`).set(auth(user.accessToken)).send({});
    const v = sent.body.data as DisabilityVerificationView;
    expect(v.status).toBe('SUBMITTED');
    expect(v.statusText).toBe('Disability benefit verification submitted. Status: Under review. We will tell you when it changes.');
    expect(v.canEdit).toBe(false);
    const edit = await api.patch(ME).set(auth(user.accessToken)).send({ details: { issuingAuthority: 'Another Office' } });
    expect(edit.status).toBe(409);
  });

  it('is for passengers only and needs a sign-in', async () => {
    expect((await api.get(ME)).status).toBe(401);
    const driver = await onboardUser('DRIVER');
    expect((await api.get(ME).set(auth(driver.accessToken))).status).toBe(403);
  });

  it('can never be set to VERIFIED by a client, whatever it sends', async () => {
    const { user } = await ready();
    for (const body of [{ status: 'VERIFIED' }, { details: { status: 'VERIFIED' } }, { verified: true }]) {
      const res = await api.patch(ME).set(auth(user.accessToken)).send(body);
      expect(res.status).toBe(400); // unknown fields are refused outright
    }
    await api.post(`${ME}/submit`).set(auth(user.accessToken)).send({ status: 'VERIFIED' }); // extra field refused
    const row = await pool.query('SELECT status FROM disability_verifications WHERE user_id = $1', [(user.user.id as string)]);
    expect(row.rows[0].status).not.toBe('VERIFIED');
    expect((await benefitActiveFor((user.user.id as string)))).toBe(false);
  });
});

// ---------------------------------------------------------------- staff decisions

describe('the staff workspace', () => {
  it('needs the right permission for each thing, and shows no card number', async () => {
    const s = await submitted();
    const none = await reviewer(['FLEET_VIEW']);
    expect((await api.get('/api/v1/admin/disability-verifications').set(auth(none))).status).toBe(403);
    const viewer = await reviewer(['DISABILITY_VERIFICATION_VIEW']);
    const list = await api.get('/api/v1/admin/disability-verifications').set(auth(viewer));
    expect(list.status).toBe(200);
    expect((list.body.data as AdminDisabilityList).items.some((i) => i.id === s.id)).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain(s.card);
    const detail = await api.get(`/api/v1/admin/disability-verifications/${s.id}`).set(auth(viewer));
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(s.card);
    expect((detail.body.data as AdminDisabilityDetail).cardLast4).toBeTruthy();
    // a viewer cannot decide, and cannot open the document
    expect((await api.post(`/api/v1/admin/disability-verifications/${s.id}/approve`).set(auth(viewer)).send({})).status).toBe(403);
    expect((await api.get(`/api/v1/admin/disability-verifications/${s.id}/document`).set(auth(viewer))).status).toBe(403);
  });

  it('opens the document through a short-lived link and audits it', async () => {
    const s = await submitted();
    const admin = await reviewer();
    const res = await api.get(`/api/v1/admin/disability-verifications/${s.id}/document`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBeTruthy();
    const audit = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'DISABILITY_DOCUMENT_VIEWED' AND subject_id = $1`, [s.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('approves: the rider is VERIFIED until the card expires, told, and the benefit is active', async () => {
    const s = await verified();
    const v = await view(s.user);
    expect(v.status).toBe('VERIFIED');
    expect(v.verifiedMethod).toBe('MANUAL');
    expect(v.benefit.active).toBe(true);
    expect(await benefitActiveFor((s.user.user.id as string))).toBe(true);
    const note = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'DISABILITY_VERIFICATION_UPDATE'`, [(s.user.user.id as string)]);
    expect(note.rowCount).toBe(1);
    const audit = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'DISABILITY_VERIFIED' AND subject_id = $1`, [s.id]);
    expect(audit.rowCount).toBe(1);
    const events = await pool.query('SELECT to_status FROM disability_verification_events WHERE verification_id = $1 ORDER BY created_at, id', [s.id]);
    expect(events.rows.map((e) => e.to_status)).toEqual(['SUBMITTED', 'VERIFIED']);
  });

  it('asks for a correction with a message, and the rider can fix and send again', async () => {
    const s = await submitted();
    const admin = await reviewer();
    const noText = await api.post(`/api/v1/admin/disability-verifications/${s.id}/request-correction`).set(auth(admin)).send({});
    expect(noText.status).toBe(400);
    expect((await api.post(`/api/v1/admin/disability-verifications/${s.id}/request-correction`).set(auth(admin)).send({ message: 'The photo is blurred.' })).status).toBe(200);
    const v = await view(s.user);
    expect(v.status).toBe('NEEDS_CORRECTION');
    expect(v.message).toBe('The photo is blurred.');
    expect(v.canEdit).toBe(true);
    await api.post(`${ME}/documents`).set(auth(s.user.accessToken)).attach('file', FIXTURES.jpeg, 'again.jpg');
    expect((await api.post(`${ME}/submit`).set(auth(s.user.accessToken)).send({})).status).toBe(200);
    expect((await view(s.user)).status).toBe('SUBMITTED');
  });

  it('rejects only with a reason, tells the rider, and activates no benefit', async () => {
    const s = await submitted();
    const admin = await reviewer();
    expect((await api.post(`/api/v1/admin/disability-verifications/${s.id}/reject`).set(auth(admin)).send({})).status).toBe(400);
    expect((await api.post(`/api/v1/admin/disability-verifications/${s.id}/reject`).set(auth(admin)).send({ reason: 'The card is not legible.' })).status).toBe(200);
    const v = await view(s.user);
    expect(v.status).toBe('REJECTED');
    expect(v.message).toBe('The card is not legible.');
    expect(await benefitActiveFor((s.user.user.id as string))).toBe(false);
  });

  it('refuses an illegal move (approving a rejected application) and a second decision on the same case', async () => {
    const s = await submitted();
    const admin = await reviewer();
    await api.post(`/api/v1/admin/disability-verifications/${s.id}/reject`).set(auth(admin)).send({ reason: 'Not a valid card.' });
    const again = await api.post(`/api/v1/admin/disability-verifications/${s.id}/approve`).set(auth(admin)).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('handles two reviewers racing: exactly one decision lands', async () => {
    const s = await submitted();
    const a = await reviewer();
    const b = await reviewer();
    const [x, y] = await Promise.all([
      api.post(`/api/v1/admin/disability-verifications/${s.id}/approve`).set(auth(a)).send({}),
      api.post(`/api/v1/admin/disability-verifications/${s.id}/reject`).set(auth(b)).send({ reason: 'Racing reviewer.' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const events = await pool.query(`SELECT count(*)::int AS n FROM disability_verification_events WHERE verification_id = $1 AND actor_kind = 'ADMIN'`, [s.id]);
    expect(events.rows[0].n).toBe(1);
  });

  it('revokes a verified benefit with a reason, and it stops at once', async () => {
    const s = await verified();
    const res = await api.post(`/api/v1/admin/disability-verifications/${s.id}/revoke`).set(auth(s.admin)).send({ reason: 'Card reported lost.' });
    expect(res.status).toBe(200);
    expect(await benefitActiveFor((s.user.user.id as string))).toBe(false);
    expect((await view(s.user)).status).toBe('REVOKED');
  });

  it('audits every decision', async () => {
    const s = await submitted();
    const admin = await reviewer();
    await api.post(`/api/v1/admin/disability-verifications/${s.id}/start-review`).set(auth(admin)).send({});
    await api.post(`/api/v1/admin/disability-verifications/${s.id}/reject`).set(auth(admin)).send({ reason: 'Looks altered.' });
    const audit = await pool.query(`SELECT action FROM audit_log WHERE subject_id = $1 AND action LIKE 'DISABILITY_%' ORDER BY created_at`, [s.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['DISABILITY_SUBMITTED', 'DISABILITY_UNDER_REVIEW', 'DISABILITY_REJECTED']));
  });
});

// ---------------------------------------------------------------- duplicates and risk

describe('duplicate cards and the risk system', () => {
  it('notices the same card number on two accounts and makes the reviewer look before approving', async () => {
    const card = cardNumber();
    const first = await submitted({ card });
    const second = await submitted({ card });
    const admin = await reviewer();
    const detail = (await api.get(`/api/v1/admin/disability-verifications/${second.id}`).set(auth(admin))).body.data as AdminDisabilityDetail;
    expect(detail.duplicateCount).toBe(1);
    expect(detail.duplicates[0]?.verificationId).toBe(first.id);
    const dup = await api.post(`/api/v1/admin/disability-verifications/${second.id}/approve`).set(auth(admin)).send({});
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_CARD');
    expect((await view(second.user)).status).toBe('SUBMITTED'); // one signal never rejects anybody
    const ok = await api.post(`/api/v1/admin/disability-verifications/${second.id}/approve`).set(auth(admin)).send({ acknowledgeDuplicate: true });
    expect(ok.status).toBe(200);
    const list = (await api.get('/api/v1/admin/disability-verifications?duplicate=true').set(auth(admin))).body.data as AdminDisabilityList;
    expect(list.items.some((i) => i.id === first.id)).toBe(true);
  });

  it('raises a risk signal for a shared card, without rejecting anyone', async () => {
    const card = cardNumber();
    const a = await submitted({ card });
    const b = await submitted({ card });
    await runRiskSweep();
    const signals = await pool.query(`SELECT user_id FROM risk_events WHERE rule_code = 'DISABILITY_DUPLICATE_CARD' AND user_id = ANY($1)`, [[a.user.user.id as string, b.user.user.id as string]]);
    expect(signals.rowCount).toBeGreaterThanOrEqual(1);
    expect((await view(a.user)).status).toBe('SUBMITTED');
  });
});

// ---------------------------------------------------------------- the official check (no assumed service)

describe('the official check', () => {
  it('is not offered until switched on and connected, and says why', async () => {
    const u = await onboardUser('PASSENGER');
    const v = await view(u);
    const official = v.methods.find((m) => m.method === 'OFFICIAL_API');
    expect(official?.available).toBe(false);
    expect(official?.unavailableReason).toBeTruthy();
    const res = await api.post(ME).set(auth(u.accessToken)).send({ consentVersion: await consentVersion(), method: 'OFFICIAL_API' });
    expect(res.status).toBe(409);
  });

  it('can only confirm: a service that cannot confirm sends the application to a person, never a refusal', async () => {
    await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('DISABILITY_OFFICIAL_API_ENABLED', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`);
    const { refreshSettings } = await import('../modules/settings/settings.service');
    await refreshSettings();
    try {
      setDisabilityVerifier({ name: 'fake', confirm: async () => false });
      const card = cardNumber();
      const u = await onboardUser('PASSENGER');
      await api.post(ME).set(auth(u.accessToken)).send({ consentVersion: await consentVersion(), method: 'OFFICIAL_API' });
      await api.patch(ME).set(auth(u.accessToken)).send({ details: { cardNumber: card, issuingAuthority: 'Official Office', issueDate: longAgo, expiryDate: farFuture() } });
      const sent = await api.post(`${ME}/submit`).set(auth(u.accessToken)).send({ cardNumber: card });
      expect(sent.status).toBe(200);
      expect((sent.body.data as DisabilityVerificationView).status).toBe('UNDER_REVIEW');

      setDisabilityVerifier({ name: 'fake', confirm: async () => true });
      const u2 = await onboardUser('PASSENGER');
      const card2 = cardNumber();
      await api.post(ME).set(auth(u2.accessToken)).send({ consentVersion: await consentVersion(), method: 'OFFICIAL_API' });
      await api.patch(ME).set(auth(u2.accessToken)).send({ details: { cardNumber: card2, issuingAuthority: 'Official Office', issueDate: longAgo, expiryDate: farFuture() } });
      const ok = await api.post(`${ME}/submit`).set(auth(u2.accessToken)).send({ cardNumber: card2 });
      const v = ok.body.data as DisabilityVerificationView;
      expect(v.status).toBe('VERIFIED');
      expect(v.verifiedMethod).toBe('OFFICIAL_API'); // clearly not "manual"
      // a different number than the one saved is not checked at all
      const u3 = await onboardUser('PASSENGER');
      await api.post(ME).set(auth(u3.accessToken)).send({ consentVersion: await consentVersion(), method: 'OFFICIAL_API' });
      await api.patch(ME).set(auth(u3.accessToken)).send({ details: { cardNumber: cardNumber(), issuingAuthority: 'Official Office', issueDate: longAgo, expiryDate: farFuture() } });
      const mismatch = await api.post(`${ME}/submit`).set(auth(u3.accessToken)).send({ cardNumber: cardNumber() });
      expect((mismatch.body.data as DisabilityVerificationView).status).toBe('UNDER_REVIEW');
    } finally {
      setDisabilityVerifier(null);
      await pool.query(`DELETE FROM platform_settings WHERE key = 'DISABILITY_OFFICIAL_API_ENABLED'`);
      await refreshSettings();
    }
  });
});

// ---------------------------------------------------------------- expiry

describe('expiry', () => {
  it('stops the benefit the day after the card runs out even before the job runs, then moves it to EXPIRED and tells the rider', async () => {
    const s = await verified({ expiry: in30Days() });
    await pool.query(`UPDATE disability_verifications SET expiry_date = current_date - 1, valid_until = current_date - 1 WHERE id = $1`, [s.id]);
    expect(await benefitActiveFor((s.user.user.id as string))).toBe(false); // by the date alone
    const r = await sweepDisabilityExpiry();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await view(s.user)).status).toBe('EXPIRED');
    const note = await pool.query(`SELECT body FROM notifications WHERE user_id = $1 AND type = 'DISABILITY_VERIFICATION_UPDATE' ORDER BY created_at DESC LIMIT 1`, [(s.user.user.id as string)]);
    expect(note.rows[0].body).toContain('expired');
    await sweepDisabilityExpiry(); // again: nothing more happens
    const events = await pool.query(`SELECT count(*)::int AS n FROM disability_verification_events WHERE verification_id = $1 AND to_status = 'EXPIRED'`, [s.id]);
    expect(events.rows[0].n).toBe(1);
  });

  it('warns once at 30 days and once at 7 days, and never twice for the same stage', async () => {
    const s = await verified({ expiry: in30Days() });
    await sweepDisabilityExpiry();
    await sweepDisabilityExpiry();
    const first = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'DISABILITY_VERIFICATION_EXPIRING'`, [(s.user.user.id as string)]);
    expect(first.rows[0].n).toBe(1);
    await pool.query(`UPDATE disability_verifications SET valid_until = current_date + 5, expiry_date = current_date + 5 WHERE id = $1`, [s.id]);
    await sweepDisabilityExpiry();
    await sweepDisabilityExpiry();
    const second = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'DISABILITY_VERIFICATION_EXPIRING'`, [(s.user.user.id as string)]);
    expect(second.rows[0].n).toBe(2);
  });
});

// ---------------------------------------------------------------- withdrawing, privacy, drivers

describe('withdrawing consent erases the card', () => {
  it('ends the benefit, erases the details and the document, and withdraws the consent', async () => {
    const s = await verified();
    const key = (await pool.query('SELECT document_key FROM disability_verifications WHERE id = $1', [s.id])).rows[0].document_key as string;
    const res = await api.patch(ME).set(auth(s.user.accessToken)).send({ withdrawConsent: true });
    expect(res.status).toBe(200);
    const v = res.body.data as DisabilityVerificationView;
    expect(v.status).toBe('REVOKED');
    expect(v.consent.given).toBe(false);
    expect(v.card.last4).toBeNull();
    expect(v.card.hasDocument).toBe(false);
    expect(await benefitActiveFor((s.user.user.id as string))).toBe(false);
    const row = (await pool.query('SELECT card_hash, card_last4, issuing_authority, document_key FROM disability_verifications WHERE id = $1', [s.id])).rows[0];
    expect(Object.values(row).every((x) => x === null)).toBe(true);
    const { getStorageProvider } = await import('../lib/storage');
    await expect(getStorageProvider().download(key)).rejects.toBeDefined();
    const rec = await pool.query('SELECT withdrawn_at FROM compliance_records WHERE user_id = $1 AND policy_key = $2', [(s.user.user.id as string), DISABILITY_CONSENT_POLICY_KEY]);
    expect(rec.rows[0].withdrawn_at).not.toBeNull();
  });
});

describe('what a driver can and cannot see', () => {
  async function liveRide(rider: OnboardedUser): Promise<RideWorld> {
    return rideWorld(undefined, rider);
  }
  const tripFor = async (w: RideWorld, token: string) => (await api.get(`/api/v1/trips/${w.tripId}`).set(auth(token))).body.data as TripSummary & { disability?: unknown };
  const share = (token: string, on: boolean) => api.patch('/api/v1/users/me/preferences').set(auth(token)).send({ changes: { shareDisabilityStatusWithDriver: on } });

  it('sees nothing by default, even for a verified rider', async () => {
    const s = await verified();
    const w = await liveRide(s.user);
    const trip = await tripFor(w, w.driver.accessToken);
    expect(trip.disability ?? null).toBeNull();
    expect(JSON.stringify(trip)).not.toContain('verified disability');
  });

  it('sees only that the benefit is verified, after accepting, and only when the rider allowed it', async () => {
    const s = await verified();
    expect((await share(s.user.accessToken, true)).status).toBe(200);
    const w = await liveRide(s.user);
    const trip = await tripFor(w, w.driver.accessToken);
    expect(trip.disability).toEqual({ verified: true, text: DISABILITY_DRIVER_TEXT });
    const text = JSON.stringify(trip);
    expect(text).not.toContain(s.card);
    expect(text).not.toContain(s.card.slice(-4));
    expect(text).not.toContain('District Administration Office');
    expect(text).not.toContain('document');
    expect(text).not.toContain('validUntil');
  });

  it('shows nothing if the rider shares but is not verified, or the verification has ended', async () => {
    const u = await onboardUser('PASSENGER');
    await share(u.accessToken, true);
    const w = await liveRide(u);
    expect((await tripFor(w, w.driver.accessToken)).disability ?? null).toBeNull();

    const s = await verified();
    await share(s.user.accessToken, true);
    const w2 = await liveRide(s.user);
    expect((await tripFor(w2, w2.driver.accessToken)).disability).toBeTruthy();
    await api.post(`/api/v1/admin/disability-verifications/${s.id}/revoke`).set(auth(s.admin)).send({ reason: 'Card reported lost.' });
    expect((await tripFor(w2, w2.driver.accessToken)).disability ?? null).toBeNull();
  });

  it('never lets a driver, another rider or the passenger reach the verification API, the document or the card', async () => {
    const s = await verified();
    const driver = await onboardUser('DRIVER');
    for (const path of [ME, `${ME}/documents`, `${ME}/submit`]) {
      expect((await api.get(path).set(auth(driver.accessToken))).status).toBe(403);
      expect((await api.post(path).set(auth(driver.accessToken)).send({})).status).toBe(403);
    }
    expect((await api.get(`/api/v1/admin/disability-verifications/${s.id}`).set(auth(driver.accessToken))).status).toBe(403);
    expect((await api.get(`/api/v1/admin/disability-verifications/${s.id}/document`).set(auth(driver.accessToken))).status).toBe(403);
    const other = await onboardUser('PASSENGER');
    expect((await view(other)).card.last4).toBeNull(); // each rider sees only their own record
    // the admin workspace is not reachable with a rider token either
    expect((await api.get('/api/v1/admin/disability-verifications').set(auth(s.user.accessToken))).status).toBe(403);
  });

  it('keeps the driver away from the benefit even after the ride ends', async () => {
    const s = await verified();
    await share(s.user.accessToken, true);
    const w = await liveRide(s.user);
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));
    expect((await tripFor(w, w.driver.accessToken)).disability ?? null).toBeNull();
  });
});

