import { createHmac } from 'node:crypto';

import {
  DISABILITY_AUTHORITY_MAX,
  DISABILITY_AUTHORITY_MIN,
  DISABILITY_CONSENT_POLICY_KEY,
  DISABILITY_EDITABLE_STATUSES,
  DISABILITY_EXPIRY_WARNING_DAYS,
  DISABILITY_METHOD_LABELS,
  DISABILITY_METHODS,
  DISABILITY_NOTIFICATION_TYPES,
  DISABILITY_PASSENGER_WORDS,
  DISABILITY_DRIVER_TEXT,
  cardDatesProblem,
  cardLast4,
  cardNumberProblem,
  checkDisabilityMove,
  daysUntil,
  disabilityAnnouncement,
  disabilityExpiryReminder,
  disabilityExpiryState,
  disabilityExpiryWarningText,
  disabilityNotification,
  normalizeCardNumber,
  submissionGaps,
  type DisabilityActor,
  type DisabilityDetailsBody,
  type DisabilityHistoryEntry,
  type DisabilityMethod,
  type DisabilityMethodOption,
  type DisabilityVerificationStatus,
  type DisabilityVerificationView,
  type TripDisabilityNote,
} from '@yatri/types';
import type { PoolClient } from 'pg';

import { env } from '../../config/env';
import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { detectFileType } from '../../lib/file-signature';
import { log } from '../../lib/logger';
import { notify } from '../../lib/notifications';
import { generateStorageKey, sanitizeDisplayFilename } from '../../lib/safe-filename';
import { getStorageProvider } from '../../lib/storage';
import { HttpError } from '../../middleware/errorHandler';
import { acceptPolicy, listPolicies, withdrawConsent } from '../compliance/compliance.service';
import { todayKey } from '../fleet/expiry.service';
import { preferenceValue } from '../preferences/preferences.service';
import { settingBool } from '../settings/settings.service';
import { getDisabilityVerifier, officialMethodState } from './verifier';

/**
 * Disability benefit verification. VOLUNTARY and PRIVATE: a rider opts in, consents (the existing consent system),
 * submits a card and its document, and is told the result. Only this module moves a verification between states, under the
 * row lock, by the one transition table in @yatri/types; a client can ask, never set. The card number is never stored: only
 * a keyed hash (to notice one card on two accounts, a reason to look and never a refusal) and its last four characters.
 *
 * The benefit itself is not here. It is an ordinary campaign (growth) that asks `benefitActiveFor`, so its value is
 * configuration and the discount and any points go through the one promotion engine and the one points ledger.
 */

// ---------------------------------------------------------------- rows and small helpers

export interface VerificationRow {
  id: string;
  user_id: string;
  status: DisabilityVerificationStatus;
  method: DisabilityMethod;
  verified_method: DisabilityMethod | null;
  card_hash: string | null;
  card_last4: string | null;
  issuing_authority: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  document_key: string | null;
  document_name: string | null;
  document_mime: string | null;
  document_size: number | null;
  document_uploaded_at: Date | null;
  message: string | null;
  submitted_at: Date | null;
  decided_at: Date | null;
  verified_at: Date | null;
  valid_until: string | null;
  warned_days: number | null;
  updated_at: Date;
}

/** The columns of a verification, optionally for a table alias. Dates are read as plain YYYY-MM-DD text, never as a moment in a time zone. */
export const columnsFor = (alias = ''): string => {
  const p = alias ? `${alias}.` : '';
  return [
    'id', 'user_id', 'status', 'method', 'verified_method', 'card_hash', 'card_last4', 'issuing_authority',
    `to_char(${p}issue_date, 'YYYY-MM-DD') AS issue_date`, `to_char(${p}expiry_date, 'YYYY-MM-DD') AS expiry_date`,
    'document_key', 'document_name', 'document_mime', 'document_size', 'document_uploaded_at', 'message', 'submitted_at',
    'decided_at', 'verified_at', `to_char(${p}valid_until, 'YYYY-MM-DD') AS valid_until`, 'warned_days', 'updated_at',
  ]
    .map((c) => (c.includes(' AS ') ? c : `${p}${c}`))
    .join(', ');
};
export const COLUMNS = columnsFor();

/**
 * Hash a card number with a key derived from the storage signing secret (a separate purpose, so one leak does not open
 * both). Two accounts holding the same number hash the same; nothing can recover the number from the hash.
 */
const cardKey = () => createHmac('sha256', env.STORAGE_SIGNING_SECRET).update('yatri:disability-card:v1').digest();
export const hashCard = (raw: string): string =>
  createHmac('sha256', cardKey()).update(normalizeCardNumber(raw)).digest('hex');

export const featureOn = () => settingBool('DISABILITY_VERIFICATION_ENABLED');
function requireFeature(): void {
  if (!featureOn()) {
    throw new HttpError(503, 'DISABILITY_VERIFICATION_OFF', 'Disability benefit verification is not available right now.');
  }
}

async function loadRow(userId: string, client?: PoolClient, lock = false): Promise<VerificationRow | null> {
  const sql = `SELECT ${COLUMNS} FROM disability_verifications WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`;
  const r = client ? await client.query<VerificationRow>(sql, [userId]) : await query<VerificationRow>(sql, [userId]);
  return r.rows[0] ?? null;
}

async function ensureRow(userId: string, client: PoolClient): Promise<VerificationRow> {
  await client.query(`INSERT INTO disability_verifications (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  return (await loadRow(userId, client, true)) as VerificationRow;
}

/** Whether the rider's consent to use their card details is in force (given and not withdrawn). */
export async function consentActive(userId: string, client?: PoolClient): Promise<{ active: boolean; givenAt: Date | null }> {
  const sql = `SELECT accepted_at FROM compliance_records
               WHERE user_id = $1 AND policy_key = $2 AND withdrawn_at IS NULL ORDER BY accepted_at DESC LIMIT 1`;
  const r = client
    ? await client.query<{ accepted_at: Date }>(sql, [userId, DISABILITY_CONSENT_POLICY_KEY])
    : await query<{ accepted_at: Date }>(sql, [userId, DISABILITY_CONSENT_POLICY_KEY]);
  return { active: !!r.rows[0], givenAt: r.rows[0]?.accepted_at ?? null };
}

/**
 * THE question the rest of the system asks: does this rider have a verified, unexpired disability benefit with consent in
 * force right now? Expiry is checked against the date itself, so a card stops counting the day after it runs out even if the
 * nightly job has not yet moved it to EXPIRED.
 */
export async function benefitActiveFor(userId: string): Promise<boolean> {
  if (!featureOn()) return false;
  const r = await query<{ active: boolean }>(
    `SELECT ${benefitActiveSql('$1::uuid', '$2::date', '$3::text')} AS active`,
    [userId, todayKey(), DISABILITY_CONSENT_POLICY_KEY],
  );
  return r.rows[0]?.active === true;
}

/**
 * The ONE rule for "this rider's disability benefit is active", as a SQL expression, so a query over many riders (a message
 * audience) and the single-rider check above can never disagree. The arguments are SQL (a column or a typed parameter).
 */
export const benefitActiveSql = (userExpr: string, todayExpr: string, consentKeyExpr: string): string =>
  `EXISTS (SELECT 1 FROM disability_verifications v
           WHERE v.user_id = ${userExpr} AND v.status = 'VERIFIED' AND v.valid_until >= ${todayExpr}
             AND EXISTS (SELECT 1 FROM compliance_records c
                         WHERE c.user_id = v.user_id AND c.policy_key = ${consentKeyExpr} AND c.withdrawn_at IS NULL))`;

/**
 * What the driver of an accepted ride may be told, and nothing else: that the rider has a verified benefit, if and only if
 * the rider allowed it. Never an identity, a card number, a document, a status history or an expiry date.
 */
export async function driverNoteFor(
  trip: { passenger_id: string; driver_id: string | null; status: string },
  viewerId: string,
  live: boolean,
): Promise<TripDisabilityNote | null> {
  if (!trip.driver_id || trip.driver_id !== viewerId || !live) return null; // only the assigned driver, only while the ride is live
  if ((await preferenceValue(trip.passenger_id, 'shareDisabilityStatusWithDriver')) !== true) return null;
  if (!(await benefitActiveFor(trip.passenger_id))) return null;
  return { verified: true, text: DISABILITY_DRIVER_TEXT };
}

// ---------------------------------------------------------------- the one place a verification moves

interface MoveOptions {
  actor: DisabilityActor;
  actorId: string | null;
  method?: DisabilityMethod | null;
  /** A reason, a correction message or a note. */
  note?: string | null;
}

/**
 * Move a locked verification to a new state: checks the move against the one transition table and the actor, writes the
 * state and the history, and returns what to tell the rider. Must be called inside the row's transaction.
 */
async function applyMove(
  client: PoolClient,
  row: VerificationRow,
  to: DisabilityVerificationStatus,
  o: MoveOptions,
): Promise<{ row: VerificationRow; notice: { title: string; body: string } | null }> {
  const check = checkDisabilityMove(row.status, to, o.actor);
  if (!check.ok) throw new HttpError(409, 'INVALID_TRANSITION', check.reason);
  const note = o.note?.trim() || null;
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const args: unknown[] = [row.id, to];
  const set = (col: string, value: unknown) => {
    args.push(value);
    sets.push(`${col} = $${args.length}`);
  };
  switch (to) {
    case 'SUBMITTED':
      sets.push('submitted_at = now()', 'decided_at = NULL', 'verified_at = NULL', 'valid_until = NULL', 'verified_method = NULL', 'warned_days = NULL');
      set('message', null);
      set('decided_by', null);
      break;
    case 'UNDER_REVIEW':
      if (o.actor === 'ADMIN') set('decided_by', o.actorId);
      break;
    case 'VERIFIED':
      sets.push('verified_at = now()', 'decided_at = now()', 'warned_days = NULL');
      set('decided_by', o.actorId);
      set('verified_method', o.method ?? row.method);
      set('valid_until', row.expiry_date);
      set('message', null);
      break;
    case 'NEEDS_CORRECTION':
    case 'REJECTED':
      sets.push('decided_at = now()');
      set('decided_by', o.actorId);
      set('message', note);
      break;
    case 'REVOKED':
      sets.push('decided_at = now()');
      set('decided_by', o.actorId);
      set('message', note);
      break;
    case 'EXPIRED':
      sets.push('decided_at = now()');
      break;
    case 'NOT_SUBMITTED':
      break;
  }
  const updated = await client.query<VerificationRow>(
    `UPDATE disability_verifications SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
    args,
  );
  await client.query(
    `INSERT INTO disability_verification_events (verification_id, from_status, to_status, actor_kind, actor_id, method, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.id, row.status, to, o.actor, o.actorId, o.method ?? null, note],
  );
  // The rider is told about decisions others made, not about the steps they took themselves.
  const notice = o.actor === 'PASSENGER' ? null : disabilityNotification(to, note);
  return { row: updated.rows[0] as VerificationRow, notice };
}

async function tell(userId: string, id: string, to: DisabilityVerificationStatus, notice: { title: string; body: string } | null) {
  if (!notice) return;
  await notify({
    userId,
    type: DISABILITY_NOTIFICATION_TYPES.DISABILITY_VERIFICATION_UPDATE,
    title: notice.title,
    body: notice.body,
    metadata: { verificationId: id, status: to },
  }).catch((err) => log.warn('Disability notification failed', err));
}

/** Remove everything about a card: its details and its document (the bytes included). */
async function eraseCard(client: PoolClient, row: VerificationRow): Promise<void> {
  await client.query(
    `UPDATE disability_verifications SET card_hash = NULL, card_last4 = NULL, issuing_authority = NULL, issue_date = NULL,
       expiry_date = NULL, document_key = NULL, document_name = NULL, document_mime = NULL, document_size = NULL,
       document_uploaded_at = NULL, valid_until = NULL, updated_at = now() WHERE id = $1`,
    [row.id],
  );
}

async function deleteDocumentBytes(key: string | null): Promise<void> {
  if (!key) return;
  await getStorageProvider().delete(key).catch((err) => log.warn('Could not remove a card document', err));
}

// ---------------------------------------------------------------- the rider's view

async function consentInfo(userId: string) {
  const policy = (await listPolicies('PASSENGER')).find((p) => p.key === DISABILITY_CONSENT_POLICY_KEY);
  const state = await consentActive(userId);
  return {
    policyKey: DISABILITY_CONSENT_POLICY_KEY,
    title: policy?.title ?? 'Using your disability identity card details',
    version: policy?.version ?? '1',
    contentUrl: policy?.contentUrl ?? null,
    given: state.active,
    givenAt: state.givenAt?.toISOString() ?? null,
  };
}

function methodOptions(): DisabilityMethodOption[] {
  const official = officialMethodState();
  return DISABILITY_METHODS.map((m) => ({
    method: m,
    label: DISABILITY_METHOD_LABELS[m].label,
    help: DISABILITY_METHOD_LABELS[m].help,
    available: m === 'MANUAL' ? true : official.available,
    unavailableReason: m === 'MANUAL' ? null : official.reason,
  }));
}

function gapsOf(row: VerificationRow | null, consentGiven: boolean): string[] {
  return submissionGaps(
    {
      consentGiven,
      method: row?.method ?? 'MANUAL',
      hasCardNumber: !!row?.card_hash,
      issuingAuthority: row?.issuing_authority ?? null,
      issueDate: row?.issue_date ?? null,
      expiryDate: row?.expiry_date ?? null,
      hasDocument: !!row?.document_key,
    },
    todayKey(),
  );
}

async function historyOf(rowId: string): Promise<DisabilityHistoryEntry[]> {
  const r = await query<{ created_at: Date; to_status: DisabilityVerificationStatus; actor_kind: DisabilityActor; note: string | null }>(
    `SELECT created_at, to_status, actor_kind, note FROM disability_verification_events
     WHERE verification_id = $1 ORDER BY created_at DESC, id LIMIT 30`,
    [rowId],
  );
  return r.rows.map((e) => ({
    at: e.created_at.toISOString(),
    toStatus: e.to_status,
    text: `${DISABILITY_PASSENGER_WORDS[e.to_status].headline}${e.note && e.actor_kind !== 'PASSENGER' ? ` ${e.note}` : ''}`,
  }));
}

/** What the rider's own screen shows. Words and permissions come from the server; the app shows them. */
export async function viewFor(userId: string): Promise<DisabilityVerificationView> {
  const row = await loadRow(userId);
  const status: DisabilityVerificationStatus = row?.status ?? 'NOT_SUBMITTED';
  const consent = await consentInfo(userId);
  const today = todayKey();
  const gaps = gapsOf(row, consent.given);
  const words = DISABILITY_PASSENGER_WORDS[status];
  const editable = (DISABILITY_EDITABLE_STATUSES as readonly string[]).includes(status);
  const active = await benefitActiveFor(userId);
  const daysLeft = row?.valid_until && status === 'VERIFIED' ? daysUntil(row.valid_until, today) : null;
  return {
    enabled: featureOn(),
    status,
    statusLabel: words.label,
    statusText: disabilityAnnouncement(status),
    method: row?.method ?? 'MANUAL',
    verifiedMethod: row?.verified_method ?? null,
    methods: methodOptions(),
    consent,
    card: {
      last4: row?.card_last4 ?? null,
      issuingAuthority: row?.issuing_authority ?? null,
      issueDate: row?.issue_date ?? null,
      expiryDate: row?.expiry_date ?? null,
      hasDocument: !!row?.document_key,
      documentName: row?.document_name ?? null,
    },
    message: row?.message ?? null,
    submittedAt: row?.submitted_at?.toISOString() ?? null,
    verifiedAt: row?.verified_at?.toISOString() ?? null,
    validUntil: row?.valid_until ?? null,
    expiry: {
      daysLeft,
      state: row?.valid_until && status === 'VERIFIED' ? disabilityExpiryState(row.valid_until, today) : null,
    },
    canOptIn: featureOn() && !consent.given,
    canEdit: featureOn() && consent.given && editable,
    canSubmit: featureOn() && consent.given && editable && gaps.length === 0,
    gaps: featureOn() && consent.given && editable ? gaps : [],
    canWithdraw: consent.given || (!!row && status !== 'NOT_SUBMITTED'),
    driverSharing: (await preferenceValue(userId, 'shareDisabilityStatusWithDriver')) === true,
    benefit: {
      active,
      text: active
        ? 'Your disability benefit applies to eligible rides. The fare screen shows it before you book.'
        : status === 'VERIFIED'
          ? 'Your benefit is not active right now.'
          : 'No disability benefit is active. It starts once your verification is approved.',
    },
    history: row ? await historyOf(row.id) : [],
  };
}

// ---------------------------------------------------------------- the rider's actions

/** Opt in: record the consent (the existing consent system) and open the rider's record. */
export async function optIn(userId: string, body: { consentVersion: string; method?: DisabilityMethod }): Promise<DisabilityVerificationView> {
  requireFeature();
  if (body.method === 'OFFICIAL_API' && !officialMethodState().available) {
    throw new HttpError(409, 'METHOD_UNAVAILABLE', officialMethodState().reason ?? 'That check is not available.');
  }
  await acceptPolicy(userId, 'PASSENGER', DISABILITY_CONSENT_POLICY_KEY, body.consentVersion); // refuses an out-of-date version
  await withTransaction(async (client) => {
    const row = await ensureRow(userId, client);
    if (body.method && body.method !== row.method) {
      await client.query('UPDATE disability_verifications SET method = $2, updated_at = now() WHERE id = $1', [row.id, body.method]);
    }
  });
  await recordAudit({ actorId: userId, actorRole: 'PASSENGER', action: 'DISABILITY_CONSENT_GIVEN', subjectType: 'user', subjectIds: [userId], detail: {} });
  return viewFor(userId);
}

const validAuthority = (v: string) => v.trim().length >= DISABILITY_AUTHORITY_MIN && v.trim().length <= DISABILITY_AUTHORITY_MAX;

/** Save the card's details (never the number itself) while the application is still the rider's to edit. */
export async function saveDetails(userId: string, d: DisabilityDetailsBody): Promise<DisabilityVerificationView> {
  requireFeature();
  if (d.method === 'OFFICIAL_API' && !officialMethodState().available) {
    throw new HttpError(409, 'METHOD_UNAVAILABLE', officialMethodState().reason ?? 'That check is not available.');
  }
  await withTransaction(async (client) => {
    if (!(await consentActive(userId, client)).active) {
      throw new HttpError(409, 'CONSENT_REQUIRED', 'Please give your consent first.');
    }
    const row = await ensureRow(userId, client);
    if (!(DISABILITY_EDITABLE_STATUSES as readonly string[]).includes(row.status)) {
      throw new HttpError(409, 'NOT_EDITABLE', 'Your application is with a reviewer, so it cannot be changed now.');
    }
    const issue = d.issueDate ?? row.issue_date;
    const expiry = d.expiryDate ?? row.expiry_date;
    if (d.cardNumber !== undefined) {
      const p = cardNumberProblem(d.cardNumber);
      if (p) throw new HttpError(400, 'VALIDATION_ERROR', p);
    }
    if (d.issuingAuthority !== undefined && !validAuthority(d.issuingAuthority)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `Who issued the card needs ${DISABILITY_AUTHORITY_MIN} to ${DISABILITY_AUTHORITY_MAX} characters.`);
    }
    const dates = cardDatesProblem({ issueDate: issue, expiryDate: expiry }, todayKey());
    if (dates && (d.issueDate !== undefined || d.expiryDate !== undefined)) throw new HttpError(400, 'VALIDATION_ERROR', dates);
    await client.query(
      `UPDATE disability_verifications SET
         card_hash = COALESCE($2, card_hash), card_last4 = COALESCE($3, card_last4),
         issuing_authority = COALESCE($4, issuing_authority), issue_date = COALESCE($5::date, issue_date),
         expiry_date = COALESCE($6::date, expiry_date), method = COALESCE($7, method), updated_at = now()
       WHERE id = $1`,
      [
        row.id,
        d.cardNumber !== undefined ? hashCard(d.cardNumber) : null,
        d.cardNumber !== undefined ? cardLast4(d.cardNumber) : null,
        d.issuingAuthority?.trim() ?? null,
        d.issueDate ?? null,
        d.expiryDate ?? null,
        d.method ?? null,
      ],
    );
  });
  return viewFor(userId);
}

/** Store the card's photo or PDF behind the storage provider (the same file checks as every other document). */
export async function saveDocument(userId: string, file: { buffer: Buffer; size: number; originalname: string }): Promise<DisabilityVerificationView> {
  requireFeature();
  if (file.size > env.MAX_UPLOAD_FILE_SIZE_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', 'That file is too large.');
  const detected = detectFileType(file.buffer);
  if (!detected) throw new HttpError(400, 'INVALID_FILE_TYPE', 'Only JPEG, PNG, or PDF files are accepted.');
  const key = generateStorageKey(`disability/${userId}`, detected.extension);
  let oldKey: string | null = null;
  await withTransaction(async (client) => {
    if (!(await consentActive(userId, client)).active) throw new HttpError(409, 'CONSENT_REQUIRED', 'Please give your consent first.');
    const row = await ensureRow(userId, client);
    if (!(DISABILITY_EDITABLE_STATUSES as readonly string[]).includes(row.status)) {
      throw new HttpError(409, 'NOT_EDITABLE', 'Your application is with a reviewer, so it cannot be changed now.');
    }
    await getStorageProvider().upload({ key, buffer: file.buffer, contentType: detected.mimeType });
    oldKey = row.document_key;
    await client.query(
      `UPDATE disability_verifications SET document_key = $2, document_name = $3, document_mime = $4, document_size = $5,
         document_uploaded_at = now(), updated_at = now() WHERE id = $1`,
      [row.id, key, sanitizeDisplayFilename(file.originalname), detected.mimeType, file.size],
    );
  }).catch(async (err) => {
    await deleteDocumentBytes(key); // the row did not take it: do not leave the bytes behind
    throw err;
  });
  await deleteDocumentBytes(oldKey);
  return viewFor(userId);
}

/**
 * Send the application. The server lists anything still missing (the same list the app shows). An official check, when the
 * rider chose it and it is available, can only CONFIRM; otherwise (or if it cannot be asked) the application goes to a reviewer.
 */
export async function submit(userId: string, body: { cardNumber?: string } = {}): Promise<DisabilityVerificationView> {
  requireFeature();
  const moved = await withTransaction(async (client) => {
    const consent = await consentActive(userId, client);
    const row = await ensureRow(userId, client);
    const gaps = gapsOf(row, consent.active);
    if (gaps.length > 0) throw new HttpError(400, 'INCOMPLETE', gaps[0] as string).withDetails({ gaps });
    if (row.method === 'OFFICIAL_API' && !officialMethodState().available) {
      throw new HttpError(409, 'METHOD_UNAVAILABLE', officialMethodState().reason ?? 'That check is not available.');
    }
    const out = await applyMove(client, row, 'SUBMITTED', { actor: 'PASSENGER', actorId: userId, method: row.method });
    return { row: out.row };
  });
  await recordAudit({ actorId: userId, actorRole: 'PASSENGER', action: 'DISABILITY_SUBMITTED', subjectType: 'disability_verification', subjectIds: [moved.row.id], detail: { method: moved.row.method } });

  if (moved.row.method === 'OFFICIAL_API') await tryOfficialCheck(userId, moved.row, body.cardNumber);
  return viewFor(userId);
}

/** The official check: confirmation verifies; anything else sends the application to a person. Never a refusal. */
async function tryOfficialCheck(userId: string, row: VerificationRow, cardNumber: string | undefined): Promise<void> {
  const verifier = getDisabilityVerifier();
  let confirmed = false;
  // The number is needed for this one call: it must be the one already saved (same hash) and is never stored.
  if (verifier && cardNumber && row.card_hash === hashCard(cardNumber) && row.issuing_authority && row.issue_date && row.expiry_date) {
    try {
      confirmed = await verifier.confirm({ cardNumber, issuingAuthority: row.issuing_authority, issueDate: row.issue_date, expiryDate: row.expiry_date });
    } catch {
      confirmed = false; // could not be asked: a person looks at it
    }
  }
  const out = await withTransaction(async (client) => {
    const locked = await loadRow(userId, client, true);
    if (!locked || locked.status !== 'SUBMITTED') return null;
    return applyMove(client, locked, confirmed ? 'VERIFIED' : 'UNDER_REVIEW', {
      actor: 'SYSTEM',
      actorId: null,
      method: 'OFFICIAL_API',
      note: confirmed ? 'Confirmed by the official verification service.' : 'The official check could not confirm the card, so a reviewer will look at it.',
    });
  });
  if (!out) return;
  await recordAudit({ actorId: null, actorRole: 'SYSTEM', action: confirmed ? 'DISABILITY_VERIFIED_OFFICIAL' : 'DISABILITY_SENT_TO_REVIEW', subjectType: 'disability_verification', subjectIds: [row.id], detail: { method: 'OFFICIAL_API' } });
  await tell(userId, row.id, out.row.status, out.notice);
}

/**
 * The rider steps away. A verified benefit ends (REVOKED); an application not yet decided, or one that was decided against,
 * goes back to "not submitted". Either way the card details and the document are erased and the consent is withdrawn, so
 * nothing about the card is kept and the driver can see nothing.
 */
export async function withdraw(userId: string): Promise<DisabilityVerificationView> {
  let oldKey: string | null = null;
  await withTransaction(async (client) => {
    const row = await loadRow(userId, client, true);
    if (row && row.status !== 'NOT_SUBMITTED') {
      const to: DisabilityVerificationStatus = row.status === 'VERIFIED' ? 'REVOKED' : 'NOT_SUBMITTED';
      const check = checkDisabilityMove(row.status, to, 'PASSENGER');
      if (!check.ok) throw new HttpError(409, 'INVALID_TRANSITION', check.reason);
      oldKey = row.document_key;
      await applyMove(client, row, to, { actor: 'PASSENGER', actorId: userId, note: 'The rider withdrew their consent.' });
      await eraseCard(client, row);
    } else if (row) {
      oldKey = row.document_key;
      await eraseCard(client, row);
    }
    await withdrawConsent(userId, DISABILITY_CONSENT_POLICY_KEY, client);
  });
  await deleteDocumentBytes(oldKey);
  await recordAudit({ actorId: userId, actorRole: 'PASSENGER', action: 'DISABILITY_CONSENT_WITHDRAWN', subjectType: 'user', subjectIds: [userId], detail: {} });
  return viewFor(userId);
}

// ---------------------------------------------------------------- staff decisions (called by the admin module)

export interface StaffMove {
  to: DisabilityVerificationStatus;
  adminId: string;
  note?: string | null;
  acknowledgeDuplicate?: boolean;
}

/** How many OTHER riders hold a card with this number (a reason to look, never proof). */
export async function duplicateCount(row: Pick<VerificationRow, 'id' | 'card_hash'>): Promise<number> {
  if (!row.card_hash) return 0;
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM disability_verifications
     WHERE card_hash = $1 AND id <> $2 AND status IN ('SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'NEEDS_CORRECTION')`,
    [row.card_hash, row.id],
  );
  return r.rows[0]?.n ?? 0;
}

/** An administrator's decision. Every one is audited; approving a card that is also on another account needs an acknowledgement. */
export async function staffMove(verificationId: string, m: StaffMove): Promise<VerificationRow> {
  const moved = await withTransaction(async (client) => {
    const found = await client.query<VerificationRow>(`SELECT ${COLUMNS} FROM disability_verifications WHERE id = $1 FOR UPDATE`, [verificationId]);
    const row = found.rows[0];
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Verification not found.');
    if (m.to === 'VERIFIED') {
      if (row.expiry_date && row.expiry_date < todayKey()) {
        throw new HttpError(409, 'CARD_EXPIRED', 'This card has expired, so it cannot be approved.');
      }
      const others = await duplicateCount(row);
      if (others > 0 && !m.acknowledgeDuplicate) {
        throw new HttpError(409, 'DUPLICATE_CARD', `This card number is also on ${others} other ${others === 1 ? 'account' : 'accounts'}. Look at them, then approve again and confirm you have.`).withDetails({ duplicates: others });
      }
    }
    const out = await applyMove(client, row, m.to, { actor: 'ADMIN', actorId: m.adminId, method: 'MANUAL', note: m.note ?? null });
    return { out, from: row.status, userId: row.user_id };
  });
  await recordAudit({
    actorId: m.adminId,
    actorRole: 'ADMIN',
    action: `DISABILITY_${m.to}`,
    subjectType: 'disability_verification',
    subjectIds: [verificationId],
    detail: { from: moved.from, to: m.to, method: 'MANUAL', acknowledgedDuplicate: !!m.acknowledgeDuplicate, hasNote: !!m.note },
  });
  await tell(moved.userId, verificationId, m.to, moved.out.notice);
  return moved.out.row;
}

// ---------------------------------------------------------------- retention

/**
 * The retention rule for card details: once an application has ended (not submitted, rejected, expired or revoked) and has sat
 * untouched for the retention period, its card details and its document are erased. A verified card is never purged while
 * the benefit may be used. The history of moves stays (it holds no card detail). Returns how many were erased.
 */
export async function purgeOldDisabilityCards(days: number): Promise<number> {
  const old = await query<{ id: string; document_key: string | null }>(
    `SELECT id, document_key FROM disability_verifications
     WHERE status IN ('NOT_SUBMITTED', 'REJECTED', 'EXPIRED', 'REVOKED')
       AND (card_hash IS NOT NULL OR document_key IS NOT NULL)
       AND updated_at < now() - ($1::int * interval '1 day')
     LIMIT 500`,
    [days],
  );
  for (const row of old.rows) {
    await deleteDocumentBytes(row.document_key);
    await query(
      `UPDATE disability_verifications SET card_hash = NULL, card_last4 = NULL, issuing_authority = NULL, issue_date = NULL,
         expiry_date = NULL, document_key = NULL, document_name = NULL, document_mime = NULL, document_size = NULL,
         document_uploaded_at = NULL, valid_until = NULL WHERE id = $1`,
      [row.id],
    );
  }
  return old.rows.length;
}

// ---------------------------------------------------------------- expiry (the `disability-expiry` job)

/**
 * Cards past their date become EXPIRED (the benefit stops, the rider is told), and riders whose card is about to run out are
 * reminded once per threshold. Safe to run again and from two servers: each move is under the row lock and re-checked.
 */
export async function sweepDisabilityExpiry(): Promise<{ expired: number; warned: number }> {
  const today = todayKey();
  const due = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM disability_verifications WHERE status = 'VERIFIED' AND valid_until < $1::date LIMIT 500`,
    [today],
  );
  let expired = 0;
  for (const d of due.rows) {
    const out = await withTransaction(async (client) => {
      const row = await loadRow(d.user_id, client, true);
      if (!row || row.status !== 'VERIFIED' || !row.valid_until || row.valid_until >= today) return null;
      return applyMove(client, row, 'EXPIRED', { actor: 'SYSTEM', actorId: null });
    });
    if (!out) continue;
    expired += 1;
    await recordAudit({ actorId: null, actorRole: 'SYSTEM', action: 'DISABILITY_EXPIRED', subjectType: 'disability_verification', subjectIds: [d.id], detail: {} });
    await tell(d.user_id, d.id, 'EXPIRED', out.notice);
  }

  const soon = await query<VerificationRow>(
    `SELECT ${COLUMNS} FROM disability_verifications
     WHERE status = 'VERIFIED' AND valid_until >= $1::date AND valid_until <= $1::date + $2::int LIMIT 500`,
    [today, Math.max(...DISABILITY_EXPIRY_WARNING_DAYS)],
  );
  let warned = 0;
  for (const v of soon.rows) {
    if (!v.valid_until) continue;
    const left = daysUntil(v.valid_until, today);
    const stage = disabilityExpiryReminder(left);
    if (stage === null || (v.warned_days !== null && v.warned_days <= stage)) continue; // already warned at this stage or a closer one
    const claimed = await query(`UPDATE disability_verifications SET warned_days = $2 WHERE id = $1 AND (warned_days IS NULL OR warned_days > $2)`, [v.id, stage]);
    if ((claimed.rowCount ?? 0) === 0) continue;
    const text = disabilityExpiryWarningText(left);
    await notify({
      userId: v.user_id,
      type: DISABILITY_NOTIFICATION_TYPES.DISABILITY_VERIFICATION_EXPIRING,
      title: text.title,
      body: text.body,
      metadata: { verificationId: v.id, daysLeft: left },
      dedupeKey: `disability-expiring:${v.id}:${stage}:${v.valid_until}`,
    }).catch((err) => log.warn('Disability expiry warning failed', err));
    warned += 1;
  }
  return { expired, warned };
}

