import type { ApiErrorShape, ApiResponse, AppUser } from '@yatri/shared';

import { env } from './env';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface SessionPayload {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${env.API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });

  const payload: ApiResponse<T> = await response.json();
  if (!payload.success) {
    const error: ApiErrorShape = payload.error;
    throw new ApiError(response.status, error.code, error.message);
  }
  return payload.data;
}

export function adminLogin(email: string, password: string) {
  return request<{ user: AppUser } & SessionPayload>('/auth/admin/login', {
    method: 'POST',
    body: { email, password },
  });
}

export function refreshAdminSession(refreshToken: string) {
  return request<SessionPayload>('/auth/refresh', { method: 'POST', body: { refreshToken } });
}

export async function getAdminMe(accessToken: string) {
  const response = await fetch(`${env.API_BASE_URL}/admin/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const payload: ApiResponse<AppUser> = await response.json();
  if (!payload.success)
    throw new ApiError(response.status, payload.error.code, payload.error.message);
  return payload.data;
}

export async function logoutAdminSession(accessToken: string) {
  const response = await fetch(`${env.API_BASE_URL}/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({}),
    cache: 'no-store',
  });
  // Best-effort: the admin's cookies are cleared regardless of the result.
  return response.ok;
}
