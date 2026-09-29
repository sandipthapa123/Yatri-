import { query } from '../../lib/db';
import type { RejectReason } from '../tracking/tracking.rules';
import { claimFlagSlot } from './presence.state';

/**
 * Foundation for spotting fake GPS. Deliberately simple, deliberately
 * non-punitive: it records indicators for later analysis and never changes a
 * driver's state on its own — one odd reading is not evidence of fraud.
 */
export type LocationFlagKind =
  'MOCK_LOCATION' | 'IMPLAUSIBLE_SPEED' | 'LOCATION_JUMP' | 'ACCURACY_TOO_PERFECT';

export const MAX_PLAUSIBLE_SPEED_MPS = 70; // ≈ 250 km/h

export interface FlagInput {
  mockLocation?: boolean;
  speedMps?: number | null;
  accuracyMeters?: number | null;
  rejected?: RejectReason | null;
}

export function detectFlags(i: FlagInput): LocationFlagKind[] {
  const flags: LocationFlagKind[] = [];
  if (i.mockLocation) flags.push('MOCK_LOCATION');
  if (i.speedMps !== null && i.speedMps !== undefined && i.speedMps > MAX_PLAUSIBLE_SPEED_MPS) {
    flags.push('IMPLAUSIBLE_SPEED');
  }
  if (i.rejected === 'impossible_jump') flags.push('LOCATION_JUMP');
  // Real GPS never reports exactly zero error.
  if (i.accuracyMeters === 0) flags.push('ACCURACY_TOO_PERFECT');
  return flags;
}

export async function recordFlags(
  driverId: string,
  kinds: LocationFlagKind[],
  details: Record<string, unknown>,
): Promise<void> {
  for (const kind of kinds) {
    if (!(await claimFlagSlot(driverId, kind))) continue; // at most one per kind per minute
    await query(
      `INSERT INTO driver_location_flags (driver_id, kind, details) VALUES ($1, $2, $3::jsonb)`,
      [driverId, kind, JSON.stringify(details)],
    );
  }
}
