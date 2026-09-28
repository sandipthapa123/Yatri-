import type { AppUser, DriverStatus, UserRole } from '@yatri/shared';

export type { UserRole, DriverStatus };

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface RequestOtpResponse {
  expiresAt: string;
  resendAvailableInSeconds: number;
  /** Only present when the API's OTP_DEV_MODE is on (never in production). */
  devOtp?: string;
}

export interface VerifyOtpResponse extends SessionTokens {
  user: AppUser;
  isNewUser: boolean;
  driverStatus?: DriverStatus;
}

export type DriverProfile = AppUser & { driverStatus: DriverStatus };
