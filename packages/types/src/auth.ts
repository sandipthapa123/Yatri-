import type { DriverStatus } from './driver-verification';
import type { AppUser } from './index';

/**
 * Signing in with a phone number: the ONE definition of what the API answers and what the apps read. The server decides every
 * figure here (how long the code is, how long to wait before another); an app never assumes one.
 */

/** A signed-in session's tokens, as every sign-in and refresh returns them. */
export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** POST /auth/request-otp */
export interface RequestOtpResponse {
  expiresAt: string;
  resendAvailableInSeconds: number;
  /** How many digits the code has (the server's setting; the apps size their code entry from it). */
  codeLength: number;
  /** Only present when the API's OTP_DEV_MODE is on (never in production). */
  devOtp?: string;
}

/** POST /auth/verify-otp */
export interface VerifyOtpResponse extends SessionTokens {
  user: AppUser;
  isNewUser: boolean;
  driverStatus?: DriverStatus;
}
