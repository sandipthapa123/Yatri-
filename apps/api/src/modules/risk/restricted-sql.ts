/**
 * Whether a person is under a temporary risk restriction, as a SQL condition. It lives in its own file, with
 * no imports, so the eligibility fragments can use it without a cycle. The one definition of "restricted":
 * a `risk_profiles` row whose `restricted_until` is still in the future (nothing is ever stored as "lifted by
 * the clock", so a restriction ends by itself the moment its time passes).
 */
export const RISK_RESTRICTED_SQL = (userColumn: string) =>
  `EXISTS (SELECT 1 FROM risk_profiles rp WHERE rp.user_id = ${userColumn} AND rp.restricted_until > now())`;
