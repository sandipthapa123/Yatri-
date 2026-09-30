import { FLEET_NOTIFICATION_TYPES } from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { getOrCreateAvailability } from '../availability/availability.repository';
import { goOffline } from '../availability/availability.service';
import { checkVerificationEligibility } from '../drivers/onboarding.service';
import { ACTIVE_SQL } from '../trips/trips.repository';
import { driverFleetProblems } from './eligibility';
import { notifyDriver } from './fleet-notify';

/**
 * Keeps "online" honest: a driver who is online but can no longer be offered rides (a document expired, a
 * vehicle was suspended, the fleet or the driver was suspended) is taken offline and told why. It uses the
 * same rules that go-online uses (`checkVerificationEligibility` for papers and `driverFleetProblems` for
 * operations); it never decides eligibility itself. A driver on a ride is left to finish it. Returns
 * whether the driver was taken offline.
 */
export async function enforceEligibility(driverId: string): Promise<boolean> {
  const availability = await getOrCreateAvailability(driverId);
  if (availability.state !== 'ONLINE' && availability.state !== 'UNAVAILABLE') return false;
  const onRide = await query(
    `SELECT 1 FROM trips WHERE driver_id = $1 AND status IN ${ACTIVE_SQL} LIMIT 1`,
    [driverId],
  );
  if (onRide.rowCount) return false;
  let problems: string[];
  try {
    problems = [
      ...(await checkVerificationEligibility(driverId)).missingRequirements,
      ...(await driverFleetProblems(driverId)),
    ];
  } catch {
    return false; // no driver profile: nothing to enforce
  }
  if (problems.length === 0) return false;
  await goOffline(driverId, 'ELIGIBILITY_LOST');
  await recordAudit({
    actorId: null,
    actorRole: 'SYSTEM',
    action: 'DRIVER_TAKEN_OFFLINE',
    subjectType: 'driver_operations',
    subjectIds: [driverId],
    detail: { reasons: problems.slice(0, 5) },
  });
  await notifyDriver(
    driverId,
    FLEET_NOTIFICATION_TYPES.ELIGIBILITY_LOST,
    `You were taken offline and cannot take rides: ${problems[0]}`,
    { reasons: problems.slice(0, 5) },
  );
  return true;
}
