import { query } from '../../lib/db';

/**
 * Called from any onboarding-data mutation (driver details, vehicle,
 * document) so a driver's status flips out of NOT_STARTED the first time
 * they actually save something — without a dedicated "start onboarding"
 * endpoint the mobile app would otherwise have to remember to call.
 */
export async function markOnboardingInProgress(userId: string): Promise<void> {
  await query(
    `UPDATE driver_profiles SET status = 'IN_PROGRESS' WHERE user_id = $1 AND status = 'NOT_STARTED'`,
    [userId],
  );
}
