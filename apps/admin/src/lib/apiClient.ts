import type {
  AdminDriverDetail,
  AdminDriverListResponse,
  ApiErrorShape,
  ApiResponse,
  AppUser,
  DocumentSummary,
  DriverStatus,
  VerificationEvent,
} from '@yatri/shared';

import { env } from './env';

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
    throw new ApiError(response.status, error.code, error.message, error.details);
  }
  return payload.data;
}

/** Same as `request`, but for every `/admin/*` call, which always needs the admin's bearer token. */
async function adminRequest<T>(
  path: string,
  accessToken: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${env.API_BASE_URL}/admin${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });

  const payload: ApiResponse<T> = await response.json();
  if (!payload.success) {
    const error: ApiErrorShape = payload.error;
    throw new ApiError(response.status, error.code, error.message, error.details);
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

export function getAdminMe(accessToken: string): Promise<AppUser> {
  return adminRequest<AppUser>('/me', accessToken);
}

export interface ListAdminDriversParams {
  search?: string;
  status?: DriverStatus;
  page?: number;
  pageSize?: number;
}

export function listAdminDrivers(
  accessToken: string,
  params: ListAdminDriversParams,
): Promise<AdminDriverListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  const qs = query.toString();
  return adminRequest<AdminDriverListResponse>(`/drivers${qs ? `?${qs}` : ''}`, accessToken);
}

export function getAdminDriverDetail(
  accessToken: string,
  driverId: string,
): Promise<AdminDriverDetail> {
  return adminRequest<AdminDriverDetail>(`/drivers/${driverId}`, accessToken);
}

export function getAdminDriverDocuments(
  accessToken: string,
  driverId: string,
): Promise<DocumentSummary[]> {
  return adminRequest<DocumentSummary[]>(`/drivers/${driverId}/documents`, accessToken);
}

export function getAdminDriverHistory(
  accessToken: string,
  driverId: string,
): Promise<VerificationEvent[]> {
  return adminRequest<VerificationEvent[]>(
    `/drivers/${driverId}/verification-history`,
    accessToken,
  );
}

export function verifyDriver(accessToken: string, driverId: string): Promise<{ status: string }> {
  return adminRequest(`/drivers/${driverId}/verify`, accessToken, { method: 'POST', body: {} });
}

export function rejectDriver(
  accessToken: string,
  driverId: string,
  reason: string,
): Promise<{ status: string }> {
  return adminRequest(`/drivers/${driverId}/reject`, accessToken, {
    method: 'POST',
    body: { reason },
  });
}

export function suspendDriver(
  accessToken: string,
  driverId: string,
  reason: string,
): Promise<{ status: string }> {
  return adminRequest(`/drivers/${driverId}/suspend`, accessToken, {
    method: 'POST',
    body: { reason },
  });
}

export function approveDocument(accessToken: string, documentId: string): Promise<DocumentSummary> {
  return adminRequest(`/documents/${documentId}/approve`, accessToken, {
    method: 'POST',
    body: {},
  });
}

export function rejectDocument(
  accessToken: string,
  documentId: string,
  reason: string,
): Promise<DocumentSummary> {
  return adminRequest(`/documents/${documentId}/reject`, accessToken, {
    method: 'POST',
    body: { reason },
  });
}

export function getAdminDocumentDownloadUrl(
  accessToken: string,
  documentId: string,
): Promise<{ url: string; expiresInSeconds: number }> {
  return adminRequest(`/documents/${documentId}/download-url`, accessToken);
}

export function approveVehicle(
  accessToken: string,
  vehicleId: string,
): Promise<{ status: string }> {
  return adminRequest(`/vehicles/${vehicleId}/approve`, accessToken, { method: 'POST', body: {} });
}

export function rejectVehicle(
  accessToken: string,
  vehicleId: string,
  reason: string,
): Promise<{ status: string }> {
  return adminRequest(`/vehicles/${vehicleId}/reject`, accessToken, {
    method: 'POST',
    body: { reason },
  });
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
