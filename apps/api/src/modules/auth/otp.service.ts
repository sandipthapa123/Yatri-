import { env } from '../../config/env';
import { generateNumericOtp } from '../../lib/crypto';
import { hashSecret, OTP_HASH_ROUNDS, verifySecret } from '../../lib/password';
import { checkAndArmCooldown, checkWindowLimit, clearCooldown } from '../../lib/rate-limit';
import type { UserRole } from '../users/users.types';
import { recordAuthEvent } from './auth-event.repository';
import {
  createOtpRequest,
  findActiveOtpRequest,
  reserveOtpAttempt,
  invalidateActiveOtps,
  markOtpConsumed,
  type OtpPurpose,
} from './otp.repository';
import { getSmsProvider } from './sms';

export class OtpCooldownError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super('An OTP was already sent recently. Please wait before requesting another.');
    this.name = 'OtpCooldownError';
  }
}

export class OtpRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super('Too many OTP requests. Please try again later.');
    this.name = 'OtpRateLimitedError';
  }
}

export class OtpInvalidError extends Error {
  constructor(message = 'The code is incorrect or has expired.') {
    super(message);
    this.name = 'OtpInvalidError';
  }
}

export class OtpLockedError extends Error {
  constructor() {
    super('Too many incorrect attempts. Please request a new code.');
    this.name = 'OtpLockedError';
  }
}

export interface RequestOtpInput {
  phoneNumber: string;
  role: UserRole;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface RequestOtpResult {
  expiresAt: Date;
  resendAvailableInSeconds: number;
  /** Only ever set when OTP_DEV_MODE is on — impossible in production (env.ts enforces this). */
  devOtp?: string;
}

const PURPOSE: OtpPurpose = 'LOGIN';

export async function requestOtp(input: RequestOtpInput): Promise<RequestOtpResult> {
  const { phoneNumber, role, ipAddress, userAgent } = input;

  const cooldownKey = `otp:cooldown:${role}:${phoneNumber}`;
  const cooldownRemaining = await checkAndArmCooldown(cooldownKey, env.OTP_RESEND_COOLDOWN_SECONDS);
  if (cooldownRemaining !== null) {
    await recordAuthEvent({
      eventType: 'OTP_REQUEST_BLOCKED',
      phoneNumber,
      ipAddress,
      userAgent,
      metadata: { reason: 'cooldown', retryAfterSeconds: cooldownRemaining },
    });
    throw new OtpCooldownError(cooldownRemaining);
  }

  const phoneWindow = await checkWindowLimit(
    `otp:ratelimit:phone:${role}:${phoneNumber}`,
    env.OTP_REQUEST_MAX_PER_WINDOW,
    env.OTP_REQUEST_WINDOW_MINUTES * 60,
  );
  const ipWindow = ipAddress
    ? await checkWindowLimit(
        `otp:ratelimit:ip:${ipAddress}`,
        env.OTP_IP_REQUEST_MAX_PER_WINDOW,
        env.OTP_REQUEST_WINDOW_MINUTES * 60,
      )
    : { limited: false, retryAfterSeconds: 0 };

  if (phoneWindow.limited || ipWindow.limited) {
    await recordAuthEvent({
      eventType: 'OTP_REQUEST_BLOCKED',
      phoneNumber,
      ipAddress,
      userAgent,
      metadata: { reason: 'rate_limit' },
    });
    throw new OtpRateLimitedError(
      Math.max(phoneWindow.retryAfterSeconds, ipWindow.retryAfterSeconds),
    );
  }

  await invalidateActiveOtps(phoneNumber, role, PURPOSE);

  const code = generateNumericOtp(env.OTP_LENGTH);
  const otpHash = await hashSecret(code, OTP_HASH_ROUNDS);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000);

  await createOtpRequest({
    phoneNumber,
    role,
    purpose: PURPOSE,
    otpHash,
    expiresAt,
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    requesterIp: ipAddress,
    userAgent,
  });

  try {
    await getSmsProvider().send({
      toPhoneNumber: phoneNumber,
      body: `Your Yatri verification code is ${code}. It expires in ${env.OTP_TTL_MINUTES} minutes. Do not share this code.`,
    });
  } catch (err) {
    // The text never left: the person must not be punished for the vendor's failure. The code that was never sent is
    // withdrawn and the resend wait is lifted, so they can ask again at once (the caller answers with the fixed 503).
    await invalidateActiveOtps(phoneNumber, role, PURPOSE);
    await clearCooldown(cooldownKey);
    throw err;
  }

  await recordAuthEvent({
    eventType: 'OTP_REQUESTED',
    phoneNumber,
    ipAddress,
    userAgent,
    metadata: { role },
  });

  return {
    expiresAt,
    resendAvailableInSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
    ...(env.OTP_DEV_MODE ? { devOtp: code } : {}),
  };
}

export interface VerifyOtpInput {
  phoneNumber: string;
  role: UserRole;
  code: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export async function verifyOtp(input: VerifyOtpInput): Promise<void> {
  const { phoneNumber, role, code, ipAddress, userAgent } = input;

  const otpRequest = await findActiveOtpRequest(phoneNumber, role, PURPOSE);
  if (!otpRequest) {
    await recordAuthEvent({
      eventType: 'OTP_VERIFY_FAILED',
      phoneNumber,
      ipAddress,
      userAgent,
      metadata: { reason: 'no_active_otp' },
    });
    throw new OtpInvalidError();
  }

  // A guess is counted before it is compared (atomically), so parallel guesses cannot exceed the limit.
  const used = await reserveOtpAttempt(otpRequest.id);
  if (used === null) {
    await recordAuthEvent({
      eventType: 'OTP_LOCKED',
      phoneNumber,
      ipAddress,
      userAgent,
      metadata: { otpRequestId: otpRequest.id },
    });
    throw new OtpLockedError();
  }

  const isMatch = await verifySecret(code, otpRequest.otp_hash);
  if (!isMatch) {
    const newAttempts = used;
    if (newAttempts >= otpRequest.max_attempts) {
      await recordAuthEvent({
        eventType: 'OTP_LOCKED',
        phoneNumber,
        ipAddress,
        userAgent,
        metadata: { otpRequestId: otpRequest.id },
      });
      throw new OtpLockedError();
    }
    await recordAuthEvent({
      eventType: 'OTP_VERIFY_FAILED',
      phoneNumber,
      ipAddress,
      userAgent,
      metadata: { reason: 'mismatch', attempts: newAttempts },
    });
    throw new OtpInvalidError();
  }

  if (!(await markOtpConsumed(otpRequest.id))) throw new OtpInvalidError(); // another request used this correct code first
  await recordAuthEvent({
    eventType: 'OTP_VERIFIED',
    phoneNumber,
    ipAddress,
    userAgent,
    metadata: { role },
  });
}
