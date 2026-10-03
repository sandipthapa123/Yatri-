import type { Request, Response } from 'express';
import type {
  ApiResponse,
  DriverStatus,
  RequestOtpResponse,
  SessionTokens,
  VerifyOtpResponse,
} from '@yatri/types';

import { env } from '../../config/env';
import { createDriverProfile, findDriverProfileByUserId } from '../drivers/drivers.repository';
import {
  createPassengerOrDriver,
  findUserByEmail,
  findUserByPhoneAndRole,
} from '../users/users.repository';
import { toPublicProfile, type PublicProfile } from '../users/users.types';
import { recordAuthEvent } from './auth-event.repository';
import { HttpError } from '../../middleware/errorHandler';
import { checkWindowLimit } from '../../lib/rate-limit';
import { hashSecret, PASSWORD_HASH_ROUNDS, verifySecret } from '../../lib/password';
import {
  OtpCooldownError,
  OtpInvalidError,
  OtpLockedError,
  OtpRateLimitedError,
  requestOtp,
  verifyOtp,
} from './otp.service';
import {
  AccountNotActiveError,
  InvalidRefreshTokenError,
  issueSession,
  logout as logoutSession,
  refreshSession,
  type IssuedSession,
} from './session.service';

function requestContext(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

function sessionPayload(session: IssuedSession): SessionTokens {
  return {
    accessToken: session.accessToken,
    accessTokenExpiresInSeconds: session.accessTokenExpiresInSeconds,
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
  };
}

// Precomputed once so a login attempt against a non-existent/non-admin
// email takes roughly the same time as one against a real admin account —
// otherwise response latency alone could be used to enumerate admin emails.
const DUMMY_PASSWORD_HASH = hashSecret('not-a-real-password-used-for-timing', PASSWORD_HASH_ROUNDS);

export async function requestOtpHandler(
  req: Request,
  res: Response<ApiResponse<RequestOtpResponse>>,
) {
  const { phoneNumber, role } = req.body as { phoneNumber: string; role: 'PASSENGER' | 'DRIVER' };

  try {
    const result = await requestOtp({ phoneNumber, role, ...requestContext(req) });
    res.json({
      success: true,
      data: {
        expiresAt: result.expiresAt.toISOString(),
        resendAvailableInSeconds: result.resendAvailableInSeconds,
        codeLength: env.OTP_LENGTH,
        ...(result.devOtp ? { devOtp: result.devOtp } : {}),
      },
    });
  } catch (err) {
    if (err instanceof OtpCooldownError || err instanceof OtpRateLimitedError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
      throw new HttpError(429, 'RATE_LIMITED', err.message).withDetails({
        retryAfterSeconds: err.retryAfterSeconds,
      });
    }
    throw err;
  }
}

export async function verifyOtpHandler(
  req: Request,
  res: Response<ApiResponse<VerifyOtpResponse>>,
) {
  const { phoneNumber, role, code } = req.body as {
    phoneNumber: string;
    role: 'PASSENGER' | 'DRIVER';
    code: string;
  };
  const ctx = requestContext(req);

  try {
    await verifyOtp({ phoneNumber, role, code, ...ctx });
  } catch (err) {
    if (err instanceof OtpInvalidError) {
      throw new HttpError(401, 'INVALID_OTP', err.message);
    }
    if (err instanceof OtpLockedError) {
      throw new HttpError(429, 'OTP_LOCKED', err.message);
    }
    throw err;
  }

  let user = await findUserByPhoneAndRole(phoneNumber, role);
  const isNewUser = !user;
  if (!user) {
    user = await createPassengerOrDriver(phoneNumber, role);
    if (role === 'DRIVER') {
      await createDriverProfile(user.id);
    }
  }

  if (user.status !== 'ACTIVE') {
    await recordAuthEvent({
      eventType: 'LOGIN_FAILED',
      userId: user.id,
      phoneNumber,
      ...ctx,
      metadata: { reason: 'account_not_active', status: user.status },
    });
    throw new HttpError(
      403,
      user.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DEACTIVATED',
      `Your account is ${user.status.toLowerCase()}.`,
    );
  }

  const session = await issueSession(user.id, user.role, ctx);
  await recordAuthEvent({
    eventType: 'LOGIN_SUCCESS',
    userId: user.id,
    phoneNumber,
    ...ctx,
    metadata: { role, isNewUser },
  });

  let driverStatus: DriverStatus | undefined;
  if (role === 'DRIVER') {
    const profile = await findDriverProfileByUserId(user.id);
    driverStatus = profile?.status;
  }

  res.json({
    success: true,
    data: {
      user: toPublicProfile(user),
      isNewUser,
      ...(driverStatus ? { driverStatus } : {}),
      ...sessionPayload(session),
    },
  });
}

export async function refreshHandler(req: Request, res: Response<ApiResponse<SessionTokens>>) {
  const { refreshToken } = req.body as { refreshToken: string };
  const ctx = requestContext(req);

  try {
    const session = await refreshSession(refreshToken, ctx);
    res.json({ success: true, data: sessionPayload(session) });
  } catch (err) {
    if (err instanceof InvalidRefreshTokenError) {
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', err.message);
    }
    if (err instanceof AccountNotActiveError) {
      throw new HttpError(
        403,
        err.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DEACTIVATED',
        err.message,
      );
    }
    throw err;
  }
}

export async function logoutHandler(req: Request, res: Response<ApiResponse<{ loggedOut: true }>>) {
  const { allDevices } = req.body as { allDevices: boolean };
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');

  await logoutSession(
    { sessionId: req.auth.sessionId, userId: req.auth.userId, allDevices },
    requestContext(req),
  );
  res.json({ success: true, data: { loggedOut: true } });
}

export async function adminLoginHandler(
  req: Request,
  res: Response<ApiResponse<{ user: PublicProfile } & SessionTokens>>,
) {
  const { email, password } = req.body as { email: string; password: string };
  const ctx = requestContext(req);

  const emailWindow = await checkWindowLimit(`admin-login:email:${email}`, 10, 15 * 60);
  const ipWindow = ctx.ipAddress
    ? await checkWindowLimit(`admin-login:ip:${ctx.ipAddress}`, 20, 15 * 60)
    : { limited: false, retryAfterSeconds: 0 };

  if (emailWindow.limited || ipWindow.limited) {
    await recordAuthEvent({
      eventType: 'LOGIN_FAILED',
      email,
      ...ctx,
      metadata: { reason: 'rate_limited' },
    });
    throw new HttpError(429, 'RATE_LIMITED', 'Too many login attempts. Please try again later.');
  }

  const user = await findUserByEmail(email);
  const isValidAdmin = !!user && user.role === 'ADMIN' && !!user.password_hash;

  const passwordMatches = await verifySecret(
    password,
    isValidAdmin ? user.password_hash! : await DUMMY_PASSWORD_HASH,
  );

  if (!isValidAdmin || !passwordMatches) {
    await recordAuthEvent({
      eventType: 'LOGIN_FAILED',
      email,
      userId: user?.id ?? null,
      ...ctx,
      metadata: { reason: 'invalid_credentials' },
    });
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  if (user.status !== 'ACTIVE') {
    await recordAuthEvent({
      eventType: 'LOGIN_FAILED',
      email,
      userId: user.id,
      ...ctx,
      metadata: { reason: 'account_not_active', status: user.status },
    });
    throw new HttpError(
      403,
      user.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DEACTIVATED',
      `This admin account is ${user.status.toLowerCase()}.`,
    );
  }

  const session = await issueSession(user.id, user.role, ctx);
  await recordAuthEvent({ eventType: 'LOGIN_SUCCESS', email, userId: user.id, ...ctx });

  res.json({
    success: true,
    data: { user: toPublicProfile(user), ...sessionPayload(session) },
  });
}
