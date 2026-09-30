import { FLEET_NOTIFICATION_TYPES, reminderStage, type ExpiryItem } from '@yatri/types';

import { log } from '../../lib/logger';
import { query } from '../../lib/db';
import { settingList } from '../settings/settings.service';
import { enforceEligibility } from './enforcement';
import { expiryItems } from './expiry.service';
import { notifyDriver } from './fleet-notify';
import { liftExpiredRestrictions } from './operational.service';

/**
 * The periodic fleet check, safe to run on every instance. It
 *  1. reads every expiry item from the one expiry view (`expiryItems`),
 *  2. sends each reminder once (expiring at each configured threshold, expired, missing) through the one
 *     notification service, remembering what it sent in `expiry_notices` (a unique row per item, date and
 *     stage), so a renewed document with a new date is reminded afresh and nothing is sent twice,
 *  3. takes online drivers who can no longer be offered rides offline (`enforceEligibility`, which applies
 *     the same rules go-online uses), and
 *  4. lifts timed operational restrictions that ran out.
 * Eligibility itself is never stored: matching and go-online work it out live, so a document that expires
 * stops a driver being offered rides at once, before this job runs.
 */
export interface MonitorResult {
  reminders: number;
  takenOffline: number;
  lifted: number;
}

function stageOf(item: ExpiryItem, thresholds: readonly number[]): string | null {
  if (item.state === 'EXPIRED') return 'EXPIRED';
  if (item.state === 'MISSING') return 'MISSING';
  if (item.state === 'EXPIRING_SOON' && item.daysLeft !== null) {
    const t = reminderStage(item.daysLeft, thresholds);
    return t === null ? null : `SOON_${t}`;
  }
  return null;
}

const typeOf = (item: ExpiryItem) =>
  item.kind === 'VEHICLE_SERVICE'
    ? FLEET_NOTIFICATION_TYPES.VEHICLE_MAINTENANCE
    : item.state === 'EXPIRED'
      ? FLEET_NOTIFICATION_TYPES.DOCUMENT_EXPIRED
      : item.state === 'MISSING'
        ? FLEET_NOTIFICATION_TYPES.DOCUMENT_MISSING
        : FLEET_NOTIFICATION_TYPES.DOCUMENT_EXPIRING;

export async function runFleetMonitor(): Promise<MonitorResult> {
  const thresholds = settingList('EXPIRY_REMINDER_DAYS');
  const items = await expiryItems();
  let reminders = 0;
  for (const item of items) {
    const stage = stageOf(item, thresholds);
    // Nobody to tell for a vehicle with no driver: the expiring list shows it to administrators.
    if (!stage || !item.driverId) continue;
    const key = `${item.kind}:${item.driverId}:${item.vehicleId ?? '-'}:${item.itemKey}`;
    const first = await query(
      `INSERT INTO expiry_notices (subject_key, due_on, stage)
       VALUES ($1, COALESCE($2::date, DATE '1970-01-01'), $3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [key, item.expiresOn, stage],
    );
    if (!first.rowCount) continue; // already reminded for this date and stage
    await notifyDriver(item.driverId, typeOf(item), item.text, {
      kind: item.kind,
      vehicleId: item.vehicleId,
      expiresOn: item.expiresOn,
    });
    reminders++;
  }

  // Keep "online" honest for every driver who has something wrong right now.
  const drivers = new Set(
    items
      .filter((i) => i.state === 'EXPIRED' || i.state === 'MISSING')
      .flatMap((i) => (i.driverId ? [i.driverId] : [])),
  );
  let takenOffline = 0;
  for (const id of drivers) {
    try {
      if (await enforceEligibility(id)) takenOffline++;
    } catch (err) {
      log.error('Eligibility check failed for a driver', err);
    }
  }
  const lifted = await liftExpiredRestrictions();
  return { reminders, takenOffline, lifted };
}
