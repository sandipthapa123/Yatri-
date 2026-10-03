import type { AppUser, DriverStatus } from '@yatri/types';

// The sign-in contracts live once, in @yatri/types; this package uses them as they are.
export type {
  DriverStatus,
  RequestOtpResponse,
  SessionTokens,
  UserRole,
  VerifyOtpResponse,
} from '@yatri/types';

export type DriverProfile = AppUser & { driverStatus: DriverStatus };
