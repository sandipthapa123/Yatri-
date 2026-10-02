import {
  ROUTE_DEVIATION_RIDE_MIN_DEVIATIONS,
  RISK_CANCELLATION_MIN_SHARE_PERCENT,
  RISK_UNPAID_GRACE_HOURS,
  type RiskRuleCode,
} from '@yatri/types';

/**
 * The detectors: for each rule, ONE query that finds the people whose recent records cross the rule's threshold
 * within its window ($1 = threshold, $2 = window in hours). Rules read the records other modules already own
 * (sign-in events, trips, ratings, tickets, refunds, location flags, incentive awards): no rule keeps a copy of
 * anything, and no app holds a rule. A query returns, per person: `count` (what crossed the threshold), an
 * optional `total`, and the record ids and kinds worth looking at. Never a phone, address or coordinate.
 */
export interface DetectedRow {
  user_id: string;
  count: number;
  total?: number | null;
  trips?: string[] | null;
  related?: string[] | null;
  kinds?: string[] | null;
}

interface Detector {
  sql: string;
  /** Anything beyond the threshold and window ($3 onwards). */
  extra?: unknown[];
}

const WINDOW = (col: string) => `${col} > now() - ($2::int * interval '1 hour')`;
const IDS = (col: string, order: string, only?: string) =>
  `(array_agg(${col} ORDER BY ${order})${only ? ` FILTER (WHERE ${only})` : ''})[1:10]`;
const OWN_CANCELS = (by: string) =>
  `count(*) FILTER (WHERE t.status = 'CANCELLED' AND t.cancelled_by = '${by}')`;

export const DETECTORS: Record<RiskRuleCode, Detector> = {
  OTP_REQUEST_BURST: {
    sql: `SELECT u.id AS user_id, count(*)::int AS count
          FROM auth_events ae JOIN users u ON u.phone_number = ae.phone_number
          WHERE ae.event_type IN ('OTP_REQUESTED', 'OTP_REQUEST_BLOCKED') AND ${WINDOW('ae.created_at')}
          GROUP BY u.id HAVING count(*) >= $1`,
  },
  OTP_WRONG_CODES: {
    sql: `SELECT u.id AS user_id, count(*)::int AS count
          FROM auth_events ae JOIN users u ON u.phone_number = ae.phone_number OR u.id = ae.user_id
          WHERE ae.event_type IN ('OTP_VERIFY_FAILED', 'OTP_LOCKED') AND ${WINDOW('ae.created_at')}
          GROUP BY u.id HAVING count(*) >= $1`,
  },
  LOGIN_FAILURE_BURST: {
    sql: `SELECT u.id AS user_id, count(*)::int AS count
          FROM auth_events ae JOIN users u ON u.id = ae.user_id OR (ae.email IS NOT NULL AND u.email = ae.email)
          WHERE ae.event_type = 'LOGIN_FAILED' AND ${WINDOW('ae.created_at')}
          GROUP BY u.id HAVING count(*) >= $1`,
  },
  SUSPENDED_RETRIES: {
    sql: `SELECT ae.user_id, count(*)::int AS count
          FROM auth_events ae
          WHERE ae.event_type = 'ACCESS_BLOCKED_SUSPENDED' AND ae.user_id IS NOT NULL AND ${WINDOW('ae.created_at')}
          GROUP BY ae.user_id HAVING count(*) >= $1`,
  },
  SHARED_ADDRESS_ACCOUNTS: {
    sql: `WITH hits AS (
            SELECT DISTINCT ae.ip_address, ae.user_id FROM auth_events ae
            WHERE ae.event_type IN ('OTP_VERIFIED', 'LOGIN_SUCCESS') AND ae.user_id IS NOT NULL
              AND ae.ip_address IS NOT NULL AND ${WINDOW('ae.created_at')}),
          shared AS (
            SELECT ip_address, count(*)::int AS n, array_agg(user_id) AS ids FROM hits
            GROUP BY ip_address HAVING count(*) >= $1)
          SELECT h.user_id, max(s.n)::int AS count, (array_agg(DISTINCT o))[1:10] AS related
          FROM hits h JOIN shared s USING (ip_address), LATERAL unnest(s.ids) AS o
          WHERE o <> h.user_id GROUP BY h.user_id`,
  },
  GPS_SPOOFING_FLAGS: {
    sql: `SELECT f.driver_id AS user_id, count(*)::int AS count, array_agg(DISTINCT f.kind) AS kinds
          FROM driver_location_flags f WHERE ${WINDOW('f.created_at')}
          GROUP BY f.driver_id HAVING count(*) >= $1`,
  },
  PROMO_REDEMPTION_BURST: {
    sql: `SELECT r.user_id, count(*)::int AS count, ${IDS('r.trip_id', 'r.created_at DESC')} AS trips
          FROM campaign_redemptions r
          WHERE r.status <> 'VOID' AND r.trip_id IS NOT NULL AND ${WINDOW('r.created_at')}
          GROUP BY r.user_id HAVING count(*) >= $1`,
  },
  REFERRAL_BURST: {
    sql: `SELECT r.referrer_id AS user_id, count(*)::int AS count, (array_agg(r.referee_id ORDER BY r.created_at DESC))[1:10] AS related
          FROM referrals r WHERE ${WINDOW('r.created_at')}
          GROUP BY r.referrer_id HAVING count(*) >= $1`,
  },
  REFERRAL_SHARED_NETWORK: {
    sql: `WITH ips AS (
            SELECT DISTINCT ae.user_id, ae.ip_address FROM auth_events ae
            WHERE ae.event_type IN ('OTP_VERIFIED', 'LOGIN_SUCCESS') AND ae.user_id IS NOT NULL AND ae.ip_address IS NOT NULL)
          SELECT r.referrer_id AS user_id, count(DISTINCT r.referee_id)::int AS count, (array_agg(DISTINCT r.referee_id))[1:10] AS related
          FROM referrals r
          JOIN ips a ON a.user_id = r.referrer_id
          JOIN ips b ON b.user_id = r.referee_id AND b.ip_address = a.ip_address
          WHERE ${WINDOW('r.created_at')}
          GROUP BY r.referrer_id HAVING count(DISTINCT r.referee_id) >= $1`,
  },
  SELF_REFERRAL_ATTEMPTS: {
    sql: `SELECT l.actor_id AS user_id, count(*)::int AS count
          FROM audit_log l
          WHERE l.action = 'REFERRAL_BLOCKED' AND l.actor_id IS NOT NULL AND ${WINDOW('l.created_at')}
          GROUP BY l.actor_id HAVING count(*) >= $1`,
  },
  ROUTE_DEVIATION_PATTERN: {
    sql: `SELECT t.driver_id AS user_id, count(*)::int AS count, ${IDS('t.id', 't.ended_at DESC')} AS trips
          FROM trips t
          WHERE t.status = 'COMPLETED' AND t.driver_id IS NOT NULL AND ${WINDOW('t.ended_at')}
            AND t.route_deviations >= $3::int
          GROUP BY t.driver_id HAVING count(*) >= $1`,
    extra: [ROUTE_DEVIATION_RIDE_MIN_DEVIATIONS],
  },
  PASSENGER_CANCELLATIONS: {
    sql: `SELECT t.passenger_id AS user_id, ${OWN_CANCELS('PASSENGER')}::int AS count, count(*)::int AS total,
                 ${IDS('t.id', 't.requested_at DESC', "t.status = 'CANCELLED' AND t.cancelled_by = 'PASSENGER'")} AS trips
          FROM trips t WHERE ${WINDOW('t.requested_at')}
          GROUP BY t.passenger_id
          HAVING ${OWN_CANCELS('PASSENGER')} >= $1 AND ${OWN_CANCELS('PASSENGER')} * 100 >= $3::int * count(*)`,
    extra: [RISK_CANCELLATION_MIN_SHARE_PERCENT],
  },
  DRIVER_CANCELLATIONS: {
    sql: `SELECT t.driver_id AS user_id, ${OWN_CANCELS('DRIVER')}::int AS count, count(*)::int AS total,
                 ${IDS('t.id', 't.requested_at DESC', "t.status = 'CANCELLED' AND t.cancelled_by = 'DRIVER'")} AS trips
          FROM trips t WHERE t.driver_id IS NOT NULL AND ${WINDOW('t.requested_at')}
          GROUP BY t.driver_id
          HAVING ${OWN_CANCELS('DRIVER')} >= $1 AND ${OWN_CANCELS('DRIVER')} * 100 >= $3::int * count(*)`,
    extra: [RISK_CANCELLATION_MIN_SHARE_PERCENT],
  },
  UNPAID_RIDES: {
    sql: `SELECT t.passenger_id AS user_id, count(*)::int AS count, ${IDS('t.id', 't.ended_at DESC')} AS trips
          FROM trips t
          WHERE t.status = 'COMPLETED' AND ${WINDOW('t.ended_at')}
            AND t.ended_at < now() - ($3::int * interval '1 hour')
            AND NOT EXISTS (SELECT 1 FROM trip_payments p WHERE p.trip_id = t.id AND p.status = 'PAID')
          GROUP BY t.passenger_id HAVING count(*) >= $1`,
    extra: [RISK_UNPAID_GRACE_HOURS],
  },
  REFUND_REQUEST_BURST: {
    sql: `SELECT r.requested_by AS user_id, count(*)::int AS count, ${IDS('r.trip_id', 'r.created_at DESC')} AS trips
          FROM refunds r
          WHERE r.requested_by IS NOT NULL AND r.requested_by_role IN ('PASSENGER', 'DRIVER') AND ${WINDOW('r.created_at')}
          GROUP BY r.requested_by HAVING count(*) >= $1`,
  },
  RATING_BOOSTING: {
    sql: `WITH pairs AS (
            SELECT rater_id, ratee_id, count(*)::int AS n, ${IDS('trip_id', 'created_at DESC')} AS trips
            FROM trip_ratings WHERE stars = 5 AND ${WINDOW('created_at')}
            GROUP BY rater_id, ratee_id HAVING count(*) >= $1)
          SELECT rater_id AS user_id, n AS count, trips, ARRAY[ratee_id] AS related FROM pairs
          UNION ALL
          SELECT ratee_id, n, trips, ARRAY[rater_id] FROM pairs`,
  },
  RATING_BOMBING: {
    sql: `SELECT rater_id AS user_id, count(*)::int AS count, ${IDS('trip_id', 'created_at DESC')} AS trips
          FROM trip_ratings WHERE stars = 1 AND ${WINDOW('created_at')}
          GROUP BY rater_id HAVING count(DISTINCT ratee_id) >= $1`,
  },
  REPEAT_PAIR_RIDES: {
    sql: `WITH pairs AS (
            SELECT t.passenger_id, t.driver_id, count(*)::int AS n, ${IDS('t.id', 't.ended_at DESC')} AS trips
            FROM trips t WHERE t.status = 'COMPLETED' AND t.driver_id IS NOT NULL AND ${WINDOW('t.ended_at')}
            GROUP BY t.passenger_id, t.driver_id HAVING count(*) >= $1)
          SELECT passenger_id AS user_id, n AS count, trips, ARRAY[driver_id] AS related FROM pairs
          UNION ALL
          SELECT driver_id, n, trips, ARRAY[passenger_id] FROM pairs`,
  },
  REPEATED_DISPUTES: {
    sql: `SELECT s.requester_id AS user_id, count(*)::int AS count,
                 ${IDS('s.trip_id', 's.created_at DESC', 's.trip_id IS NOT NULL')} AS trips
          FROM support_tickets s WHERE s.is_dispute AND ${WINDOW('s.created_at')}
          GROUP BY s.requester_id HAVING count(*) >= $1`,
  },
  INCENTIVE_SPIKE: {
    sql: `SELECT a.driver_id AS user_id, sum(a.amount_npr)::int AS count, count(*)::int AS total,
                 ${IDS('a.trip_id', 'a.created_at DESC', 'a.trip_id IS NOT NULL')} AS trips
          FROM incentive_awards a WHERE ${WINDOW('a.created_at')}
          GROUP BY a.driver_id HAVING sum(a.amount_npr) >= $1`,
  },
};

/** The parameters a detector's query takes: threshold, window, then its own extras. */
export const detectorParams = (code: RiskRuleCode, threshold: number, windowHours: number) => [
  threshold,
  windowHours,
  ...(DETECTORS[code].extra ?? []),
];
