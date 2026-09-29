import type { DriverStatus } from '@yatri/types';

export type { DriverStatus };

export interface DriverProfileRow {
  user_id: string;
  status: DriverStatus;
  rejection_reason: string | null;
  submitted_at: Date | null;
  verified_at: Date | null;
  reviewed_by: string | null;
  created_at: Date;
  updated_at: Date;
}
