import {
  RISK_NOTIFICATION_TYPES,
  RISK_REVIEW_REMINDER_DAYS,
  type RiskRuleCode,
  type RiskSweepResult,
} from '@yatri/types';

import { query } from '../../lib/db';
import { log } from '../../lib/logger';
import { notify } from '../../lib/notifications';
import { settingNumber } from '../settings/settings.service';
import { adminsHolding } from '../support/support-notify';
import { DETECTORS, detectorParams, type DetectedRow } from './detectors';
import { recordSignals, scoreFor } from './events.service';
import { applyRestriction, expireRestrictions } from './restriction.service';
import { effectiveRules } from './rules';

/**
 * The risk sweep: run every enabled detector, record what they find (idempotently), then, for the people who
 * got a new signal only:
 *  - tell the risk team once per week that a review is due (no names or details in the message);
 *  - restrict temporarily, but only if an administrator has switched automatic restriction on, the score is
 *    high enough AND it came from several different kinds of signal. Only signals newer than the last
 *    restriction decision count, so an administrator lifting a restriction is not undone on the next sweep.
 * It never suspends. Two sweeps at once are safe: events are unique, the restriction is guarded, and the
 * review notice is claimed by one update.
 */
async function autoRestrictIfWarranted(userId: string): Promise<boolean> {
  const autoScore = settingNumber('RISK_AUTO_RESTRICT_SCORE');
  if (autoScore <= 0) return false;
  const since = (
    await query<{ updated_at: Date }>('SELECT updated_at FROM risk_profiles WHERE user_id = $1', [
      userId,
    ])
  ).rows[0]?.updated_at;
  const { score, rules } = await scoreFor(userId, since);
  if (score < autoScore || rules < settingNumber('RISK_MIN_DISTINCT_RULES')) return false;
  try {
    await applyRestriction({
      userId,
      hours: settingNumber('RISK_AUTO_RESTRICT_HOURS'),
      reason: 'Several different risk signals at once; an administrator will review.',
      source: 'AUTOMATIC',
      actorId: null,
    });
    return true;
  } catch {
    return false; // already restricted, suspended, or an administrator: nothing to do
  }
}

async function askForReview(userId: string): Promise<void> {
  const { score } = await scoreFor(userId);
  if (score < settingNumber('RISK_REVIEW_SCORE')) return;
  const claimed = await query(
    `INSERT INTO risk_profiles (user_id, review_notified_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET review_notified_at = now()
       WHERE risk_profiles.review_notified_at IS NULL
          OR risk_profiles.review_notified_at < now() - ($2::int * interval '1 day')
     RETURNING user_id`,
    [userId, RISK_REVIEW_REMINDER_DAYS],
  );
  if (!claimed.rowCount) return;
  for (const adminId of await adminsHolding('RISK_MANAGE')) {
    await notify({
      userId: adminId,
      type: RISK_NOTIFICATION_TYPES.REVIEW_NEEDED,
      title: 'Yatri risk',
      body: 'A person needs a risk review.',
      metadata: { userId },
    }).catch(() => undefined);
  }
}

export async function runRiskSweep(): Promise<RiskSweepResult> {
  const lifted = await expireRestrictions();
  const touched = new Set<string>();
  let eventsCreated = 0;
  for (const rule of (await effectiveRules()).filter((r) => r.enabled)) {
    const code = rule.code as RiskRuleCode;
    try {
      const found = await query<DetectedRow>(
        DETECTORS[code].sql,
        detectorParams(code, rule.threshold, rule.windowHours),
      );
      const created = await recordSignals(rule, found.rows);
      eventsCreated += created.length;
      created.forEach((u) => touched.add(u));
    } catch (err) {
      log.error('Risk detector failed', code, err);
    }
  }
  let restricted = 0;
  for (const userId of touched) {
    if (await autoRestrictIfWarranted(userId)) restricted += 1;
    await askForReview(userId).catch((err) => log.error('Risk review notice failed', err));
  }
  return { evaluated: touched.size, eventsCreated, restricted, lifted };
}

/** The retention job for RISK_EVENTS (called by compliance/retention.service). */
export async function purgeOldRiskEvents(days: number): Promise<number> {
  const r = await query(
    `DELETE FROM risk_events WHERE created_at < now() - ($1::int * interval '1 day')`,
    [days],
  );
  return r.rowCount ?? 0;
}
