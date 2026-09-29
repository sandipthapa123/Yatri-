import type { EligibilitySummary } from '@yatri/types';

import { query } from '../../lib/db';
import { checkVerificationEligibility } from '../drivers/onboarding.service';

/**
 * Can this driver go online RIGHT NOW? Decided by the server from the database on
 * every request — never from anything the mobile app sends. Reuses the strict
 * verification gate from phase 3 (`checkVerificationEligibility`: licence valid,
 * an APPROVED and unexpired vehicle, every required document APPROVED and
 * unexpired) and adds the availability-specific rules on top.
 */
export async function evaluateDriverEligibility(driverId: string): Promise<EligibilitySummary> {
  const reasons: string[] = [];

  const row = await query<{ account_status: string; driver_status: string | null }>(
    `SELECT u.status AS account_status, dp.status AS driver_status
     FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id
     WHERE u.id = $1 AND u.role = 'DRIVER'`,
    [driverId],
  );
  const r = row.rows[0];
  if (!r) return { eligible: false, reasons: ['Driver account not found.'] };

  if (r.account_status !== 'ACTIVE') reasons.push('Your account is not active.');
  if (r.driver_status === 'SUSPENDED') {
    reasons.push('Your driver account is suspended. Contact Yatri support.');
  } else if (r.driver_status !== 'VERIFIED') {
    reasons.push('Your driver verification is not complete.');
  }

  // Only worth the heavier document/vehicle check once the basics pass.
  if (reasons.length === 0) {
    const strict = await checkVerificationEligibility(driverId);
    if (!strict.eligible) reasons.push(...strict.missingRequirements);
  }

  // Availability and trips are separate axes, but a driver mid-trip must not open a second shift.
  const active = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM trips
     WHERE driver_id = $1 AND status IN ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS')`,
    [driverId],
  );
  if (Number(active.rows[0]?.n ?? 0) > 0) {
    reasons.push('You are already assigned to an active trip.');
  }

  return { eligible: reasons.length === 0, reasons };
}
