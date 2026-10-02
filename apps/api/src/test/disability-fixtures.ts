import { DISABILITY_CONSENT_POLICY_KEY, type AdminPermission, type DisabilityVerificationView } from '@yatri/types';
import { expect } from 'vitest';

import { pool } from '../config/database';
import { FIXTURES, api, loginTestAdmin, onboardUser, type OnboardedUser } from './helpers';
import { auth } from './rides';

/** Shared by the disability verification and disability benefit tests: riders at each step of the verification. */
export const ME = '/api/v1/me/disability-verification';
let n = 0;
export const reviewer = (permissions: AdminPermission[] = ['DISABILITY_VERIFICATION_VIEW', 'DISABILITY_VERIFICATION_REVIEW']) =>
  loginTestAdmin(`dis-${Date.now()}-${++n}@example.com`, 'a-strong-test-password-1', permissions);
export const cardNumber = () => `NP-${Date.now().toString(36).toUpperCase()}-${(++n).toString().padStart(4, '0')}`;
export const in30Days = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
export const longAgo = '2020-01-01';
export const farFuture = () => new Date(Date.now() + 3 * 365 * 86_400_000).toISOString().slice(0, 10);

export async function consentVersion(): Promise<string> {
  const r = await pool.query('SELECT version FROM compliance_policies WHERE key = $1', [DISABILITY_CONSENT_POLICY_KEY]);
  return r.rows[0].version as string;
}

export const view = async (u: OnboardedUser) => (await api.get(ME).set(auth(u.accessToken))).body.data as DisabilityVerificationView;

/** A rider who has opted in, entered a card and added its document, ready to send. */
export async function ready(over: { expiry?: string; card?: string; user?: OnboardedUser } = {}) {
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

export async function submitted(over: Parameters<typeof ready>[0] = {}) {
  const r = await ready(over);
  const res = await api.post(`${ME}/submit`).set(auth(r.user.accessToken)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = (await pool.query('SELECT id FROM disability_verifications WHERE user_id = $1', [(r.user.user.id as string)])).rows[0].id as string;
  return { ...r, id };
}

export async function verified(over: Parameters<typeof ready>[0] = {}) {
  const s = await submitted(over);
  const admin = await reviewer();
  const res = await api.post(`/api/v1/admin/disability-verifications/${s.id}/approve`).set(auth(admin)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { ...s, admin };
}

