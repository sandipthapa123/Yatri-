import { query } from '../../lib/db';
import { log } from '../../lib/logger';
import { sweepApprovals } from './approvals.service';
import { issueStatements, previousPeriodKey } from './statements.service';

/**
 * Business housekeeping, run by the gateway timer. Waiting approvals expire and stuck ones are restored every
 * run. Last month's statements are issued once the month is over: running this every few minutes is safe
 * because issuing is idempotent (one live statement per organization and period, and a payment is billed once).
 * It only looks for unbilled work in the first days of a month, so the rest of the time it costs one cheap query.
 */
export async function runOrganizationSweep(): Promise<void> {
  const a = await sweepApprovals();
  if (a.expired || a.restored) log.info('Organization approvals swept', a);
  const early = await query<{ ok: boolean }>('SELECT (extract(day FROM now()) <= 5) AS ok');
  if (!early.rows[0]?.ok) return;
  const r = await issueStatements(await previousPeriodKey(), null);
  if (r.issued) log.info('Statements issued', r);
}
