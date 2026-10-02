import type { GrowthDriverView } from '@yatri/types';

import { driverIncentives } from '../operations/incentives.service';

/**
 * What a driver sees from the campaign service. Driver incentives are not a second system: they remain the incentive
 * rules (operations/incentives.service.ts), and this is the one function the driver endpoints call, so the
 * driver app gets its incentive information from the same place as everything else growth-related.
 */
export async function driverCampaignView(driverId: string): Promise<GrowthDriverView> {
  return { incentives: await driverIncentives(driverId) };
}
