import {
  RETENTION_RECORD_TYPES,
  type RetentionPolicyInfo,
  type RetentionRecordType,
  type UpdateRetentionBody,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { log } from '../../lib/logger';
import { getStorageProvider } from '../../lib/storage';
import { purgeOldDisabilityCards } from '../disability/verification.service';
import { HttpError } from '../../middleware/errorHandler';
import { purgeOldRideAccessibility } from '../accessibility/accessibility.service';
import { purgeOldRiskEvents } from '../risk/sweep';

/**
 * Data retention: how long each kind of record is kept is DATA in `retention_policies` (one row per kind),
 * edited by an administrator with a stated reason and never below the floor the row carries. The job below
 * is the only code that deletes on age, and it reads the policy: nothing else holds a retention number.
 * Records that must be kept (rides, payments, refunds, tickets, safety, audit, compliance, requests) have
 * the action KEEP and no job touches them.
 */
interface Row {
  record_type: RetentionRecordType;
  label: string;
  action: 'DELETE' | 'KEEP';
  retain_days: number | null;
  min_retain_days: number | null;
  legal_basis: string;
  enforced: boolean;
  last_run_at: Date | null;
  last_run_count: number | null;
}
const toInfo = (r: Row): RetentionPolicyInfo => ({
  recordType: r.record_type,
  label: r.label,
  retainDays: r.retain_days,
  minRetainDays: r.min_retain_days,
  action: r.action,
  legalBasis: r.legal_basis,
  enforced: r.enforced,
  lastRunAt: r.last_run_at?.toISOString() ?? null,
  lastRunCount: r.last_run_count,
});
const COLS =
  'record_type, label, action, retain_days, min_retain_days, legal_basis, enforced, last_run_at, last_run_count';

export async function listRetentionPolicies(): Promise<RetentionPolicyInfo[]> {
  const r = await query<Row>(`SELECT ${COLS} FROM retention_policies`);
  const order = new Map(RETENTION_RECORD_TYPES.map((t, i) => [t, i]));
  return r.rows
    .sort((a, b) => (order.get(a.record_type) ?? 0) - (order.get(b.record_type) ?? 0))
    .map(toInfo);
}

/** The number of days a DELETE rule keeps a kind of record, or null when it is kept (or does not exist). */
export async function retentionDays(type: RetentionRecordType): Promise<number | null> {
  const r = await query<{ action: string; retain_days: number | null }>(
    'SELECT action, retain_days FROM retention_policies WHERE record_type = $1',
    [type],
  );
  const row = r.rows[0];
  return row && row.action === 'DELETE' ? row.retain_days : null;
}

export async function updateRetention(
  type: RetentionRecordType,
  body: UpdateRetentionBody,
  adminId: string,
): Promise<RetentionPolicyInfo> {
  const cur = await query<Row>(`SELECT ${COLS} FROM retention_policies WHERE record_type = $1`, [
    type,
  ]);
  const current = cur.rows[0];
  if (!current) throw new HttpError(404, 'NOT_FOUND', 'Retention rule not found.');
  if (current.action === 'KEEP') {
    throw new HttpError(
      409,
      'MUST_BE_KEPT',
      'These records must be kept. Their rule cannot be changed to delete them.',
    );
  }
  if (current.min_retain_days !== null && body.retainDays < current.min_retain_days) {
    throw new HttpError(
      400,
      'BELOW_MINIMUM',
      `This kind of record must be kept at least ${current.min_retain_days} days.`,
    ).withDetails({ retainDays: [`At least ${current.min_retain_days}`] });
  }
  const r = await query<Row>(
    `UPDATE retention_policies SET retain_days = $2, updated_at = now()
     WHERE record_type = $1 RETURNING ${COLS}`,
    [type, body.retainDays],
  );
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'RETENTION_POLICY_UPDATED',
    subjectType: 'retention_policy',
    subjectIds: null,
    detail: {
      recordType: type,
      from: current.retain_days,
      to: body.retainDays,
      reason: body.reason,
    },
  });
  return toInfo(r.rows[0] as Row);
}

/**
 * Each enforced rule, applied. Returns how many records each removed. A rule never removes evidence that is
 * still in use: chat of a ride with an unfinished ticket stays, and support files only go once their ticket
 * has been closed for the whole period.
 */
const JOBS: Record<string, (days: number) => Promise<number>> = {
  OTP_REQUESTS: async (days) =>
    (
      await query(
        `DELETE FROM otp_requests WHERE created_at < now() - ($1::int * interval '1 day')`,
        [days],
      )
    ).rowCount ?? 0,
  NOTIFICATIONS: async (days) =>
    (
      await query(
        `DELETE FROM notifications WHERE created_at < now() - ($1::int * interval '1 day')`,
        [days],
      )
    ).rowCount ?? 0,
  RISK_EVENTS: purgeOldRiskEvents,
  ACCESSIBILITY_RIDE_DETAILS: purgeOldRideAccessibility,
  DISABILITY_VERIFICATION: purgeOldDisabilityCards,
  JOB_RUNS: async (days) =>
    (
      await query(`DELETE FROM job_runs WHERE started_at < now() - ($1::int * interval '1 day')`, [
        days,
      ])
    ).rowCount ?? 0,
  IDEMPOTENCY_KEYS: async (days) =>
    (
      await query(
        `DELETE FROM idempotency_keys WHERE created_at < now() - ($1::int * interval '1 day')`,
        [days],
      )
    ).rowCount ?? 0,
  AUTH_EVENTS: async (days) =>
    (
      await query(
        `DELETE FROM auth_events WHERE created_at < now() - ($1::int * interval '1 day')`,
        [days],
      )
    ).rowCount ?? 0,
  CHAT_MESSAGES: async (days) =>
    (
      await query(
        `DELETE FROM trip_messages m USING trips t
         WHERE m.trip_id = t.id AND t.ended_at IS NOT NULL
           AND t.ended_at < now() - ($1::int * interval '1 day')
           AND NOT EXISTS (SELECT 1 FROM support_tickets s WHERE s.trip_id = t.id AND s.is_dispute
                           AND s.status NOT IN ('RESOLVED', 'CLOSED'))`,
        [days],
      )
    ).rowCount ?? 0,
  SUPPORT_EVIDENCE: async (days) => {
    const old = await query<{ id: string; storage_key: string }>(
      `SELECT a.id, a.storage_key FROM support_attachments a JOIN support_tickets t ON t.id = a.ticket_id
       WHERE t.status = 'CLOSED' AND t.closed_at < now() - ($1::int * interval '1 day') LIMIT 500`,
      [days],
    );
    for (const a of old.rows) {
      await getStorageProvider()
        .delete(a.storage_key)
        .catch(() => undefined);
    }
    if (old.rows.length > 0) {
      await query('DELETE FROM support_attachments WHERE id = ANY($1::uuid[])', [
        old.rows.map((a) => a.id),
      ]);
    }
    return old.rows.length;
  },
};

export async function runRetention(): Promise<Record<string, number>> {
  const policies = await query<{ record_type: string; retain_days: number }>(
    `SELECT record_type, retain_days FROM retention_policies
     WHERE enforced AND action = 'DELETE' AND retain_days IS NOT NULL`,
  );
  const done: Record<string, number> = {};
  for (const p of policies.rows) {
    const job = JOBS[p.record_type];
    if (!job) continue;
    try {
      const n = await job(p.retain_days);
      done[p.record_type] = n;
      await query(
        'UPDATE retention_policies SET last_run_at = now(), last_run_count = $2 WHERE record_type = $1',
        [p.record_type, n],
      );
    } catch (err) {
      log.error('Retention job failed', p.record_type, err);
    }
  }
  return done;
}
