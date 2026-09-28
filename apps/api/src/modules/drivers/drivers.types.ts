import type { DriverStatus } from '@yatri/types';

export type { DriverStatus };

export interface DriverProfileRow {
  user_id: string;
  status: DriverStatus;
  created_at: Date;
  updated_at: Date;
}
