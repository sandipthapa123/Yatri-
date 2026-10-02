import {
  ORG_NOTIFICATION_TYPES,
  ORG_STATEMENT_TRANSITIONS,
  formatNpr,
  isStatementPeriod,
  type AdminStatementRow,
  type AdminStatementRunResult,
  type OrgStatementDetail,
  type OrgStatementInfo,
  type OrgStatementLine,
  type OrgStatementStatus,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { log } from '../../lib/logger';
import { HttpError } from '../../middleware/errorHandler';
import { settingNumber } from '../settings/settings.service';
import { recordTripEvent } from '../trips/trip-events.service';
import { membersWithRoles, notifyPerson } from './org-notify';

/**
 * Monthly statements: the organization's bill. A statement is NOT a ledger and holds no amounts of its own:
 * it is a grouping of the existing payment records (`trip_payments.statement_id`, set once per payment, so a
 * ride is never billed twice) with a status and dates. Its total is always the sum of its payments.
 *
 *  - Issuing a period takes every payment still unbilled whose ride ended before that month's end (late rides
 *    roll into the next statement, never into an issued one). Running it again for the same period issues
 *    nothing new (one live statement per organization and period).
 *  - Paying is recorded by a platform administrator once the money is received: the amount must equal the
 *    total exactly, and all the statement's payments become PAID in the same transaction. Recording it twice
 *    changes nothing the second time.
 *  - Cancelling frees the payments to be billed again on another statement.
 * Yatri collects no money here (no gateway): "paid" is an administrator's record of a bank transfer.
 */
interface InfoRow {
  id: string;
  number: string;
  period_key: string;
  status: OrgStatementStatus;
  issued_at: Date;
  due_on: string;
  paid_at: Date | null;
  paid_reference: string | null;
  rides: number;
  total: number;
  organization_id: string;
  organization_name: string;
}

const SELECT = `SELECT s.id, s.number::text, s.period_key, s.status, s.issued_at, s.due_on::text, s.paid_at, s.paid_reference,
       s.organization_id, o.name AS organization_name,
       count(p.trip_id)::int AS rides, COALESCE(sum(p.amount_npr), 0)::int AS total
  FROM organization_statements s
  JOIN organizations o ON o.id = s.organization_id
  LEFT JOIN trip_payments p ON p.statement_id = s.id`;
const GROUP = 'GROUP BY s.id, o.name';

const toInfo = (r: InfoRow): OrgStatementInfo => ({
  id: r.id,
  number: Number(r.number),
  periodKey: r.period_key,
  status: r.status,
  rides: r.rides,
  totalNpr: r.total,
  issuedAt: r.issued_at.toISOString(),
  dueOn: r.due_on,
  paidAt: r.paid_at?.toISOString() ?? null,
  paidReference: r.paid_reference,
});

/** The calendar month before this one, in the platform time zone (the database session's). */
export async function previousPeriodKey(): Promise<string> {
  const r = await query<{ k: string }>(
    "SELECT to_char(date_trunc('month', now()) - interval '1 month', 'YYYY-MM') AS k",
  );
  return r.rows[0]?.k as string;
}

async function tellBilling(
  orgId: string,
  type: (typeof ORG_NOTIFICATION_TYPES)[keyof typeof ORG_NOTIFICATION_TYPES],
  body: string,
) {
  for (const id of await membersWithRoles(orgId, ['OWNER', 'ADMIN'])) {
    await notifyPerson(id, type, body, { organizationId: orgId });
  }
}

/** Issue the statements for a finished month (default: last month). Safe to run again and from two places at once. */
export async function issueStatements(
  periodKey: string | undefined,
  actorId: string | null,
): Promise<AdminStatementRunResult> {
  const key = periodKey ?? (await previousPeriodKey());
  if (!isStatementPeriod(key))
    throw new HttpError(400, 'INVALID_PERIOD', 'Use a month like 2026-09.');
  const bounds = await query<{ ended: boolean; period_end: Date }>(
    `SELECT ((($1 || '-01')::date + interval '1 month')::timestamptz <= now()) AS ended,
            (($1 || '-01')::date + interval '1 month')::timestamptz AS period_end`,
    [key],
  );
  if (!bounds.rows[0]?.ended) {
    throw new HttpError(
      409,
      'PERIOD_NOT_FINISHED',
      'That month is not over yet, so it cannot be billed.',
    );
  }
  const periodEnd = bounds.rows[0].period_end;
  const orgs = await query<{ organization_id: string }>(
    `SELECT DISTINCT t.organization_id
     FROM trip_payments p JOIN trips t ON t.id = p.trip_id
     WHERE p.method = 'ORGANIZATION' AND p.status = 'PENDING' AND p.statement_id IS NULL
       AND t.organization_id IS NOT NULL AND t.ended_at < $1`,
    [periodEnd],
  );
  let issued = 0;
  let skipped = 0;
  let failed = 0;
  for (const { organization_id: orgId } of orgs.rows) {
    // One organization's problem must not leave every later organization unbilled: each is its own transaction.
    let made: IssuedStatement | null;
    try {
      made = await issueOne(orgId, key, periodEnd);
    } catch (err) {
      failed += 1;
      log.error('Could not issue a statement', { organizationId: orgId, period: key }, err);
      continue;
    }
    if (!made) {
      skipped += 1;
      continue;
    }
    issued += 1;
    await recordAudit({
      actorId,
      actorRole: actorId ? 'ADMIN' : 'SYSTEM',
      action: 'ORG_STATEMENT_ISSUED',
      subjectType: 'organization',
      subjectIds: [orgId],
      detail: { statementId: made.id, number: made.number, period: key, rides: made.rides },
    });
    await tellBilling(
      orgId,
      ORG_NOTIFICATION_TYPES.STATEMENT_ISSUED,
      `Statement ${made.number} for ${key} is ready: ${made.rides} ride${made.rides === 1 ? '' : 's'}. Open Business to see it.`,
    ).catch((err) => log.error('Statement notice failed', err));
  }
  // The others are billed; the run still fails so the job record shows that some organization needs attention.
  if (failed > 0)
    throw new Error(
      `${failed} organization statement(s) could not be issued for ${key}; ${issued} were`,
    );
  return { periodKey: key, issued, skipped };
}

interface IssuedStatement {
  id: string;
  number: number;
  rides: number;
}

/** One organization's statement for a period, in one transaction. Null when there is nothing to bill or it already exists. */
async function issueOne(
  orgId: string,
  key: string,
  periodEnd: Date,
): Promise<IssuedStatement | null> {
  return withTransaction(async (c) => {
    await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
    const exists = await c.query(
      `SELECT 1 FROM organization_statements WHERE organization_id = $1 AND period_key = $2 AND status <> 'VOID'`,
      [orgId, key],
    );
    if (exists.rowCount) return null;
    const s = await c.query<{ id: string; number: string }>(
      `INSERT INTO organization_statements (organization_id, period_key, due_on)
       VALUES ($1, $2, current_date + $3::int) RETURNING id, number::text`,
      [orgId, key, settingNumber('ORG_PAYMENT_TERMS_DAYS')],
    );
    const id = s.rows[0]?.id as string;
    const lines = await c.query(
      `UPDATE trip_payments p SET statement_id = $1
       FROM trips t
       WHERE t.id = p.trip_id AND t.organization_id = $2 AND p.method = 'ORGANIZATION'
         AND p.status = 'PENDING' AND p.statement_id IS NULL AND t.ended_at < $3`,
      [id, orgId, periodEnd],
    );
    // Nothing to bill after all (another run took the lines): undo the empty statement and its number.
    if (!lines.rowCount) throw new NothingToBill();
    return { id, number: Number(s.rows[0]?.number), rides: lines.rowCount };
  }).catch((err) => {
    if (err instanceof NothingToBill) return null;
    throw err;
  });
}

class NothingToBill extends Error {}

export async function listStatements(orgId: string): Promise<OrgStatementInfo[]> {
  const r = await query<InfoRow>(
    `${SELECT} WHERE s.organization_id = $1 ${GROUP} ORDER BY s.issued_at DESC, s.number DESC`,
    [orgId],
  );
  return r.rows.map(toInfo);
}

export async function statementDetail(
  statementId: string,
  orgId?: string,
): Promise<OrgStatementDetail> {
  const h = await query<InfoRow>(
    `${SELECT} WHERE s.id = $1 AND ($2::uuid IS NULL OR s.organization_id = $2) ${GROUP}`,
    [statementId, orgId ?? null],
  );
  const row = h.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Statement not found.');
  const l = await query<{
    trip_id: string;
    ended_at: Date | null;
    passenger_name: string | null;
    booked_by_name: string | null;
    cost_center_code: string | null;
    cost_center_name: string | null;
    purpose: string | null;
    pickup_address: string;
    dest_address: string;
    amount: number;
  }>(
    `SELECT t.id AS trip_id, t.ended_at, p.full_name AS passenger_name, b.full_name AS booked_by_name,
            cc.code AS cost_center_code, cc.name AS cost_center_name, t.purpose,
            pl.address AS pickup_address, dl.address AS dest_address, pay.amount_npr AS amount
     FROM trip_payments pay
     JOIN trips t ON t.id = pay.trip_id
     JOIN users p ON p.id = t.passenger_id
     LEFT JOIN users b ON b.id = t.booked_by
     JOIN locations pl ON pl.id = t.pickup_location_id
     JOIN locations dl ON dl.id = t.destination_location_id
     LEFT JOIN organization_cost_centers cc ON cc.id = t.cost_center_id
     WHERE pay.statement_id = $1 ORDER BY t.ended_at, t.id`,
    [statementId],
  );
  const lines: OrgStatementLine[] = l.rows.map((x) => ({
    tripId: x.trip_id,
    endedAt: x.ended_at?.toISOString() ?? null,
    passengerName: x.passenger_name,
    bookedByName: x.booked_by_name,
    costCenterCode: x.cost_center_code,
    purpose: x.purpose,
    pickupAddress: x.pickup_address,
    destinationAddress: x.dest_address,
    amountNpr: x.amount,
  }));
  const groups = new Map<
    string,
    { code: string | null; name: string | null; rides: number; totalNpr: number }
  >();
  for (const x of l.rows) {
    const k = x.cost_center_code ?? '';
    const g = groups.get(k) ?? {
      code: x.cost_center_code,
      name: x.cost_center_name,
      rides: 0,
      totalNpr: 0,
    };
    g.rides += 1;
    g.totalNpr += x.amount;
    groups.set(k, g);
  }
  return {
    ...toInfo(row),
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    lines,
    byCostCenter: [...groups.values()].sort((a, b) => b.totalNpr - a.totalNpr),
  };
}

// ---------------------------------------------------------------- the platform's side

export async function adminListStatements(f: {
  status?: OrgStatementStatus | undefined;
  organizationId?: string | undefined;
  page: number;
  pageSize: number;
}): Promise<{ items: AdminStatementRow[]; total: number }> {
  const params = [f.status ?? null, f.organizationId ?? null];
  const where = `WHERE ($1::text IS NULL OR s.status = $1) AND ($2::uuid IS NULL OR s.organization_id = $2)`;
  const [rows, count] = await Promise.all([
    query<InfoRow>(
      `${SELECT} ${where} ${GROUP} ORDER BY s.issued_at DESC, s.number DESC LIMIT $3 OFFSET $4`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    ),
    query<{ n: number }>(
      `SELECT count(*)::int AS n FROM organization_statements s ${where}`,
      params,
    ),
  ]);
  return {
    total: count.rows[0]?.n ?? 0,
    items: rows.rows.map((r) => ({
      ...toInfo(r),
      organizationId: r.organization_id,
      organizationName: r.organization_name,
    })),
  };
}

/**
 * Record that the organization paid this statement. The only way an organization-billed payment becomes PAID.
 * One transaction: the statement and every one of its payments change together or not at all.
 */
export async function markStatementPaid(
  statementId: string,
  adminId: string,
  receivedNpr: number,
  reference: string,
): Promise<OrgStatementDetail> {
  const done = await withTransaction(async (c) => {
    const s = await c.query<{
      status: OrgStatementStatus;
      organization_id: string;
      paid_reference: string | null;
      number: string;
    }>(
      'SELECT status, organization_id, paid_reference, number::text FROM organization_statements WHERE id = $1 FOR UPDATE',
      [statementId],
    );
    const st = s.rows[0];
    if (!st) throw new HttpError(404, 'NOT_FOUND', 'Statement not found.');
    if (st.status === 'PAID') {
      if (st.paid_reference === reference) return null; // the same record again: nothing to do
      throw new HttpError(409, 'ALREADY_PAID', 'This statement was already recorded as paid.');
    }
    if (!ORG_STATEMENT_TRANSITIONS[st.status].includes('PAID')) {
      throw new HttpError(409, 'ILLEGAL_MOVE', 'A cancelled statement cannot be paid.');
    }
    const total = await c.query<{ total: number; pending: number }>(
      `SELECT COALESCE(sum(amount_npr), 0)::int AS total,
              count(*) FILTER (WHERE status <> 'PENDING')::int AS pending
       FROM trip_payments WHERE statement_id = $1`,
      [statementId],
    );
    const t = total.rows[0];
    if (!t || t.pending > 0) {
      throw new HttpError(
        409,
        'PAYMENTS_CHANGED',
        'A payment on this statement is no longer pending. Check the rides first.',
      );
    }
    if (receivedNpr !== t.total) {
      throw new HttpError(
        400,
        'AMOUNT_MISMATCH',
        `The statement total is ${formatNpr(t.total)}. Record the full amount received.`,
      );
    }
    const paid = await c.query<{ trip_id: string; amount_npr: number }>(
      `UPDATE trip_payments SET status = 'PAID', paid_at = now(), confirmed_by = $2
       WHERE statement_id = $1 AND status = 'PENDING' RETURNING trip_id, amount_npr`,
      [statementId, adminId],
    );
    await c.query(
      `UPDATE organization_statements SET status = 'PAID', paid_at = now(), paid_reference = $2, received_by = $3 WHERE id = $1`,
      [statementId, reference, adminId],
    );
    return {
      orgId: st.organization_id,
      number: Number(st.number),
      total: t.total,
      payments: paid.rows,
    };
  });
  if (done) {
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'ORG_STATEMENT_PAID',
      subjectType: 'organization',
      subjectIds: [done.orgId],
      detail: { statementId, number: done.number, totalNpr: done.total, reference },
    });
    for (const p of done.payments) {
      await recordTripEvent({
        tripId: p.trip_id,
        type: 'PAYMENT_RECEIVED',
        actorId: adminId,
        payload: { amountNpr: p.amount_npr, method: 'ORGANIZATION' },
      }).catch((err) => log.error('Payment event failed', err));
    }
    await tellBilling(
      done.orgId,
      ORG_NOTIFICATION_TYPES.STATEMENT_PAID,
      `Statement ${done.number} was recorded as paid. Thank you.`,
    );
  }
  return statementDetail(statementId);
}

/** Cancel an unpaid statement: its rides go back to being unbilled and appear on the next one. */
export async function voidStatement(
  statementId: string,
  adminId: string,
  reason: string,
): Promise<OrgStatementDetail> {
  const done = await withTransaction(async (c) => {
    const s = await c.query<{
      status: OrgStatementStatus;
      organization_id: string;
      number: string;
    }>(
      'SELECT status, organization_id, number::text FROM organization_statements WHERE id = $1 FOR UPDATE',
      [statementId],
    );
    const st = s.rows[0];
    if (!st) throw new HttpError(404, 'NOT_FOUND', 'Statement not found.');
    if (!ORG_STATEMENT_TRANSITIONS[st.status].includes('VOID')) {
      throw new HttpError(
        409,
        'ILLEGAL_MOVE',
        `A ${st.status.toLowerCase()} statement cannot be cancelled.`,
      );
    }
    await c.query('UPDATE trip_payments SET statement_id = NULL WHERE statement_id = $1', [
      statementId,
    ]);
    await c.query(
      `UPDATE organization_statements SET status = 'VOID', voided_at = now(), void_reason = $2 WHERE id = $1`,
      [statementId, reason],
    );
    return { orgId: st.organization_id, number: Number(st.number) };
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'ORG_STATEMENT_VOIDED',
    subjectType: 'organization',
    subjectIds: [done.orgId],
    detail: { statementId, number: done.number, reason },
  });
  return statementDetail(statementId);
}
