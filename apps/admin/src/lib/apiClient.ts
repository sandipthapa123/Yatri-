import type {
  AdminAccountRow,
  AdminAuditRow,
  AdminDisputeRow,
  AdminListResponse,
  AdminMe,
  AdminNotificationRow,
  AdminPaymentRow,
  AdminUserDetail,
  AdminUserRow,
  AppUser,
  AdminVehicleCategory,
  AdminVehicleRow,
  AnalyticsData,
  DashboardData,
  DriverEarningsRow,
  FinanceSummary,
  NotificationSummary,
  PlatformSettingInfo,
  PlatformSettingsResponse,
  SetPermissionsBody,
  UpdateSettingBody,
  VehicleCategoryBody,
  AdminIncidentDetail,
  AdminIncidentRow,
  AdminLowRating,
  AdminSosDetail,
  AdminSosRow,
  IncidentNoteKind,
  IncidentStatus,
  SosStatus,
  AdminTripDetail,
  AdminTripRow,
  ChatHistory,
  AdminDriverDetail,
  AdminDriverAvailabilityResponse,
  AdminDriverListResponse,
  ApiErrorShape,
  ApiResponse,
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

export function getAdminMe(accessToken: string): Promise<AdminMe> {
  return adminRequest<AdminMe>('/me', accessToken);
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

export interface ListDriverAvailabilityParams {
  search?: string;
  state?: string;
  freshness?: string;
  verification?: string;
  page?: number;
  pageSize?: number;
}

/** Server-side filtered + paginated. Coordinates come back only if this admin holds DRIVER_LOCATION_VIEW. */
export function listDriverAvailability(
  accessToken: string,
  params: ListDriverAvailabilityParams,
): Promise<AdminDriverAvailabilityResponse> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '') query.set(k, String(v));
  const qs = query.toString();
  return adminRequest<AdminDriverAvailabilityResponse>(
    `/availability/drivers${qs ? `?${qs}` : ''}`,
    accessToken,
  );
}

// ---- rides and disputes (the same authoritative records the apps use) ----------------------

const toQuery = (params: object) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export interface ListTripsParams extends RangeParams {
  status?: string;
  group?: string;
  sort?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}
export function listAdminTrips(accessToken: string, params: ListTripsParams) {
  return adminRequest<{ items: AdminTripRow[]; total: number }>(
    `/trips${toQuery(params)}`,
    accessToken,
  );
}
export function getAdminTrip(accessToken: string, tripId: string) {
  return adminRequest<AdminTripDetail>(`/trips/${tripId}`, accessToken);
}
/** Needs TRIP_CHAT_VIEW; the API refuses otherwise and writes every read to the access log. */
export function getAdminTripChat(accessToken: string, tripId: string) {
  return adminRequest<ChatHistory>(`/trips/${tripId}/chat`, accessToken);
}
export function adminCancelTrip(accessToken: string, tripId: string, reason: string) {
  return adminRequest<{ status: string }>(`/trips/${tripId}/cancel`, accessToken, {
    method: 'POST',
    body: { reason },
  });
}
export function listAdminDisputes(
  accessToken: string,
  params: { status?: string; page?: number; pageSize?: number },
) {
  return adminRequest<{ items: AdminDisputeRow[]; total: number }>(
    `/disputes${toQuery(params)}`,
    accessToken,
  );
}
export function resolveAdminDispute(
  accessToken: string,
  disputeId: string,
  status: 'RESOLVED' | 'REJECTED',
  resolution: string,
) {
  return adminRequest<unknown>(`/disputes/${disputeId}/resolve`, accessToken, {
    method: 'POST',
    body: { status, resolution },
  });
}

// ---- safety (SAFETY_REVIEW): SOS alerts, incident reports, low ratings
export function listAdminSos(
  accessToken: string,
  params: { status?: string; page?: number; pageSize?: number },
) {
  return adminRequest<{ items: AdminSosRow[]; total: number }>(
    `/sos${toQuery(params)}`,
    accessToken,
  );
}
export function getAdminSos(accessToken: string, id: string) {
  return adminRequest<AdminSosDetail>(`/sos/${id}`, accessToken);
}
export function moveAdminSos(
  accessToken: string,
  id: string,
  to: Exclude<SosStatus, 'ACTIVE' | 'CANCELLED'>,
  note?: string,
) {
  const step = to === 'ACKNOWLEDGED' ? 'acknowledge' : 'resolve';
  return adminRequest<unknown>(`/sos/${id}/${step}`, accessToken, {
    method: 'POST',
    body: note ? { note } : {},
  });
}
export function listAdminIncidents(
  accessToken: string,
  params: { status?: string; category?: string; page?: number; pageSize?: number },
) {
  return adminRequest<{ items: AdminIncidentRow[]; total: number }>(
    `/incidents${toQuery(params)}`,
    accessToken,
  );
}
export function getAdminIncident(accessToken: string, id: string) {
  return adminRequest<AdminIncidentDetail>(`/incidents/${id}`, accessToken);
}
export function setAdminIncidentStatus(
  accessToken: string,
  id: string,
  status: IncidentStatus,
  note?: string,
) {
  return adminRequest<unknown>(`/incidents/${id}/status`, accessToken, {
    method: 'POST',
    body: note ? { status, note } : { status },
  });
}
export function addAdminIncidentNote(
  accessToken: string,
  id: string,
  kind: Extract<IncidentNoteKind, 'NOTE' | 'ACTION'>,
  body: string,
) {
  return adminRequest<unknown>(`/incidents/${id}/notes`, accessToken, {
    method: 'POST',
    body: { kind, body },
  });
}
export function listAdminLowRatings(
  accessToken: string,
  params: { maxStars?: number; page?: number; pageSize?: number },
) {
  return adminRequest<{ items: AdminLowRating[]; total: number }>(
    `/ratings/low${toQuery(params)}`,
    accessToken,
  );
}

// ---- Phase 11: operations, users, money, notifications, settings, audit, administrators -----

/** The date-range parameters every report and list accepts (a preset, or two calendar dates). */
export interface RangeParams {
  range?: string;
  from?: string;
  to?: string;
}
type Paged = { page?: number; pageSize?: number };

export const getDashboard = (t: string, p: RangeParams) =>
  adminRequest<DashboardData>(`/dashboard${toQuery(p)}`, t);
export const getAnalytics = (t: string, p: RangeParams) =>
  adminRequest<AnalyticsData>(`/analytics${toQuery(p)}`, t);

export const listAdminUsers = (
  t: string,
  p: { role?: string; status?: string; search?: string; sort?: string } & Paged,
) => adminRequest<AdminListResponse<AdminUserRow>>(`/users${toQuery(p)}`, t);
export const getAdminUser = (t: string, id: string) =>
  adminRequest<AdminUserDetail>(`/users/${id}`, t);
export const setAdminUserStatus = (
  t: string,
  id: string,
  to: 'suspend' | 'reactivate',
  reason: string,
) =>
  adminRequest<{ status: string }>(`/users/${id}/${to}`, t, { method: 'POST', body: { reason } });

export const listAdminVehicles = (
  t: string,
  p: {
    status?: string;
    category?: string;
    expiring?: string;
    search?: string;
    sort?: string;
  } & Paged,
) => adminRequest<AdminListResponse<AdminVehicleRow>>(`/vehicles${toQuery(p)}`, t);

export const getFinanceSummary = (t: string, p: RangeParams) =>
  adminRequest<FinanceSummary>(`/finance/summary${toQuery(p)}`, t);
export const listAdminPayments = (
  t: string,
  p: RangeParams & { status?: string; search?: string; sort?: string } & Paged,
) => adminRequest<AdminListResponse<AdminPaymentRow>>(`/payments${toQuery(p)}`, t);
export const listDriverEarnings = (
  t: string,
  p: RangeParams & { search?: string; sort?: string } & Paged,
) => adminRequest<AdminListResponse<DriverEarningsRow>>(`/finance/earnings${toQuery(p)}`, t);

export const getNotificationSummary = (t: string, p: RangeParams) =>
  adminRequest<NotificationSummary>(`/notifications/summary${toQuery(p)}`, t);
export const listAdminNotifications = (
  t: string,
  p: RangeParams & { type?: string; read?: string; search?: string } & Paged,
) => adminRequest<AdminListResponse<AdminNotificationRow>>(`/notifications${toQuery(p)}`, t);

export const getPlatformSettings = (t: string) =>
  adminRequest<PlatformSettingsResponse>('/settings', t);
export const updatePlatformSetting = (t: string, key: string, body: UpdateSettingBody) =>
  adminRequest<PlatformSettingInfo>(`/settings/${key}`, t, { method: 'PUT', body });
export const listVehicleCategories = (t: string) =>
  adminRequest<AdminVehicleCategory[]>('/vehicle-categories', t);
export const updateVehicleCategory = (t: string, id: string, body: VehicleCategoryBody) =>
  adminRequest<AdminVehicleCategory>(`/vehicle-categories/${id}`, t, { method: 'PATCH', body });

export const listAdminAudit = (
  t: string,
  p: RangeParams & { action?: string; subjectType?: string; search?: string } & Paged,
) => adminRequest<AdminListResponse<AdminAuditRow>>(`/audit${toQuery(p)}`, t);

export const listAdminAccounts = (t: string) => adminRequest<AdminAccountRow[]>('/admins', t);
export const setAdminPermissions = (t: string, id: string, body: SetPermissionsBody) =>
  adminRequest<AdminAccountRow>(`/admins/${id}/permissions`, t, { method: 'PUT', body });
