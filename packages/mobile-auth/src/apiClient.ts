import type { ApiErrorShape, ApiResponse, AppUser } from '@yatri/shared';

import { API_BASE_URL } from './config';
import type { DriverProfile, RequestOtpResponse, UserRole, VerifyOtpResponse } from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; accessToken?: string } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  let payload: ApiResponse<T>;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      'INVALID_RESPONSE',
      'The server returned an invalid response.',
    );
  }

  if (!payload.success) {
    const error: ApiErrorShape = payload.error;
    throw new ApiError(response.status, error.code, error.message, error.details);
  }
  return payload.data;
}

export function requestOtp(phoneNumber: string, role: UserRole): Promise<RequestOtpResponse> {
  return request<RequestOtpResponse>('/auth/request-otp', {
    method: 'POST',
    body: { phoneNumber, role },
  });
}

export function verifyOtp(
  phoneNumber: string,
  role: UserRole,
  code: string,
): Promise<VerifyOtpResponse> {
  return request<VerifyOtpResponse>('/auth/verify-otp', {
    method: 'POST',
    body: { phoneNumber, role, code },
  });
}

export function refreshTokens(refreshToken: string) {
  return request<Omit<VerifyOtpResponse, 'user' | 'isNewUser' | 'driverStatus'>>('/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  });
}

export function logout(accessToken: string, allDevices = false): Promise<{ loggedOut: true }> {
  return request('/auth/logout', { method: 'POST', accessToken, body: { allDevices } });
}

export function getMe(accessToken: string): Promise<AppUser> {
  return request<AppUser>('/users/me', { accessToken });
}

export function updateMe(
  accessToken: string,
  update: { fullName?: string; profilePictureUrl?: string | null },
): Promise<AppUser> {
  return request<AppUser>('/users/me', { method: 'PATCH', accessToken, body: update });
}

export function getDriverMe(accessToken: string): Promise<DriverProfile> {
  return request<DriverProfile>('/drivers/me', { accessToken });
}

export function updateDriverMe(
  accessToken: string,
  update: { fullName?: string; profilePictureUrl?: string | null },
): Promise<DriverProfile> {
  return request<DriverProfile>('/drivers/me', { method: 'PATCH', accessToken, body: update });
}
