import {
  DISABILITY_CONSENT_POLICY_KEY,
  GROWTH_NOTIFICATION_TYPES,
  evaluateEligibility,
  describeCampaignOffer,
  type EligibilityFacts,
} from '@yatri/types';

import { query } from '../../lib/db';
import { log } from '../../lib/logger';
import { notify } from '../../lib/notifications';
import { benefitActiveSql, featureOn } from '../disability/verification.service';
import { todayKey } from '../fleet/expiry.service';
import { CAMPAIGN_COLUMNS, type CampaignRow } from './campaigns.service';

/**
 * Message campaigns and win-back offers, run by the `growth-messages` job (the one job architecture). Both are found by
 * looking at the data (what is due now), so running twice, or from two servers, sends nothing twice:
 *  - a PUSH campaign is sent through the existing notification service (then marked `sent_at`), whose
 *    dedupe key makes a repeat harmless and whose preference check records (but does not push) a message to someone who
 *    has not opted in to offers. The audience is the same eligibility rule, judged for the person alone.
 *  - a RETENTION campaign gives each rider it fits ONE offer (a grant, unique per rider and campaign) and tells them.
 * Riders only; never a driver; never anyone whose account is not active.
 */
const BATCH = 500;

interface Audience {
  id: string;
  created_days: string;
  rides: string;
  since: string | null;
  disability: boolean;
}

async function audience(
  after: string,
  rule: { inactive?: boolean },
  limit: number,
): Promise<Audience[]> {
  const r = await query<Audience>(
    `SELECT u.id,
            floor(extract(epoch FROM (now() - u.created_at)) / 86400)::text AS created_days,
            (SELECT count(*) FROM trips t WHERE t.passenger_id = u.id AND t.status = 'COMPLETED')::text AS rides,
            (SELECT floor(extract(epoch FROM (now() - max(t.ended_at))) / 86400)::text
               FROM trips t WHERE t.passenger_id = u.id AND t.status = 'COMPLETED') AS since,
            ${benefitActiveSql('u.id', `'${todayKey()}'::date`, `'${DISABILITY_CONSENT_POLICY_KEY}'`)} AS disability
     FROM users u
     WHERE u.role = 'PASSENGER' AND u.status = 'ACTIVE' AND u.id > $1::uuid
       ${rule.inactive ? "AND EXISTS (SELECT 1 FROM trips t WHERE t.passenger_id = u.id AND t.status = 'COMPLETED')" : ''}
     ORDER BY u.id LIMIT $2`,
    [after, limit],
  );
  return r.rows;
}

const factsOf = (a: Audience): EligibilityFacts => ({
  userId: a.id,
  completedRides: Number(a.rides),
  accountAgeDays: Number(a.created_days),
  daysSinceLastRide: a.since === null ? null : Number(a.since),
  disabilityVerified: a.disability && featureOn(),
  ride: null,
});

const NIL = '00000000-0000-0000-0000-000000000000';

/** Send one PUSH campaign to everyone it fits. Returns how many people it was handed to. */
async function sendPush(c: CampaignRow): Promise<number> {
  if (!c.message) return 0;
  let sent = 0;
  let after = NIL;
  for (;;) {
    const batch = await audience(after, {}, BATCH);
    if (batch.length === 0) break;
    for (const a of batch) {
      if (!evaluateEligibility(c.eligibility ?? {}, factsOf(a)).eligible) continue;
      await notify({
        userId: a.id,
        type: GROWTH_NOTIFICATION_TYPES.CAMPAIGN_MESSAGE,
        title: c.message.title,
        body: c.message.body,
        metadata: { campaignId: c.id },
        dedupeKey: `campaign:${c.id}`,
      }).catch((err) => log.warn('Campaign message failed for one rider', err));
      sent += 1;
    }
    after = (batch[batch.length - 1] as Audience).id;
  }
  return sent;
}

/** Give a win-back offer to the riders it fits who do not have it yet. Returns how many were given it. */
async function grantRetention(c: CampaignRow): Promise<number> {
  if (!c.message || !c.offer) return 0;
  let given = 0;
  let after = NIL;
  for (let batches = 0; batches < 20; batches += 1) {
    const batch = await audience(after, { inactive: true }, BATCH);
    if (batch.length === 0) break;
    for (const a of batch) {
      if (!evaluateEligibility(c.eligibility ?? {}, factsOf(a)).eligible) continue;
      const g = await query(
        `INSERT INTO campaign_grants (campaign_id, user_id, expires_at)
         VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + ($3::int * interval '1 day') END)
         ON CONFLICT DO NOTHING RETURNING id`,
        [c.id, a.id, c.valid_days_after_grant],
      );
      if (!g.rowCount) continue; // already has it
      given += 1;
      await notify({
        userId: a.id,
        type: GROWTH_NOTIFICATION_TYPES.OFFER_GRANTED,
        title: c.message.title,
        body: `${c.message.body} (${describeCampaignOffer(c.offer)})`,
        metadata: { campaignId: c.id },
        dedupeKey: `grant:${c.id}:${a.id}`,
      }).catch((err) => log.warn('Offer notice failed for one rider', err));
    }
    after = (batch[batch.length - 1] as Audience).id;
  }
  return given;
}

/** The job: send what is due, give what is due. */
export async function sweepCampaignMessages(): Promise<{ pushed: number; offers: number }> {
  let pushed = 0;
  let offers = 0;
  const due = await query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c
     WHERE c.kind = 'PUSH' AND c.status = 'ACTIVE' AND c.sent_at IS NULL AND c.starts_at IS NOT NULL AND c.starts_at <= now()
       AND (c.ends_at IS NULL OR c.ends_at > now())`,
  );
  for (const c of due.rows) {
    // Sent, then marked: a crash part-way resumes next run, and the notification's dedupe key means nobody gets it twice.
    pushed += await sendPush(c);
    await query('UPDATE campaigns SET sent_at = now() WHERE id = $1 AND sent_at IS NULL', [c.id]);
  }
  const retention = await query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c
     WHERE c.kind = 'RETENTION' AND c.status = 'ACTIVE' AND (c.starts_at IS NULL OR c.starts_at <= now())
       AND (c.ends_at IS NULL OR c.ends_at > now())`,
  );
  for (const c of retention.rows) offers += await grantRetention(c);
  return { pushed, offers };
}
