import type {
  AdminAccountRow,
  AdminCityBody,
  AdminCityRow,
  CityAnalytics,
  CityDetail,
  AccessibilityStats,
  NavigationMetrics,
  AdminAttributeBody,
  AdminCapabilityDecisionBody,
  AdminCapabilityReview,
  JobInfo,
  VehicleAttributeInfo,
  AdminFleetBody,
  AdminMarkStatementPaidBody,
  AdminOrganizationDetail,
  AdminOrganizationRow,
  AdminStatementRow,
  AdminStatementRunResult,
  OrgStatementDetail,
  AdminRiskNoteBody,
  AdminRiskRestrictBody,
  AdminRiskReviewBody,
  AdminRiskRuleBody,
  RiskEventInfo,
  RiskNoteInfo,
  RiskOverview,
  RiskRestrictionInfo,
  RiskRuleInfo,
  RiskSweepResult,
  RiskTripDetail,
  RiskUserDetail,
  RiskUserRow,
  AdminFleetVehicleBody,
  AdminInspectionBody,
  AdminLifecycleBody,
  AdminMaintenanceCompleteBody,
  AdminMaintenanceStartBody,
  AdminOperationalBody,
  AdminServiceLogBody,
  AuditEntry,
  ExpiryItem,
  FleetDetail,
  FleetDriverDetail,
  FleetDriverRow,
  FleetInfo,
  FleetVehicleDetail,
  FleetVehicleRow,
  ServiceRecordInfo,
  AdminIncentiveRuleBody,
  AdminPricingRuleBody,
  AdminZoneBody,
  HeatmapData,
  IncentiveAwardRow,
  IncentiveRuleInfo,
  PricingRuleInfo,
  ZoneDef,
  AdminAssignBody,
  AdminDataRequestRow,
  AdminNoteBody,
  AdminPriorityBody,
  AdminRefundActionBody,
  AdminRefundCreateBody,
  AdminReplyBody,
  AdminStatusBody,
  AdminTicketDetail,
  AdminTicketRow,
  ComplianceRecordInfo,
  DataRequestActionBody,
  DataRequestInfo,
  PolicyInfo,
  PublishPolicyBody,
  RefundInfo,
  RetentionPolicyInfo,
  RetentionRecordType,
  SupportCategory,
  SupportPriority,
  UpdateRetentionBody,
  AdminAuditRow,
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

// ---- support (DISPUTES_MANAGE; raising refunds SUPPORT_MANAGE; deciding them REFUNDS_MANAGE)
async function adminUpload<T>(path: string, accessToken: string, form: FormData): Promise<T> {
  const response = await fetch(`${env.API_BASE_URL}/admin${path}`, {
    method: 'POST',
    // No Content-Type: fetch sets the multipart boundary itself.
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
    cache: 'no-store',
  });
  const payload: ApiResponse<T> = await response.json();
  if (!payload.success) {
    const error: ApiErrorShape = payload.error;
    throw new ApiError(response.status, error.code, error.message, error.details);
  }
  return payload.data;
}
const post = <T>(path: string, t: string, body?: unknown) =>
  adminRequest<T>(path, t, { method: 'POST', body });

export interface TicketListParams {
  status?: string;
  group?: string;
  priority?: string;
  category?: string;
  kind?: string;
  assigned?: string;
  overdue?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}
export const listAdminTickets = (t: string, p: TicketListParams) =>
  adminRequest<{ items: AdminTicketRow[]; total: number }>(`/support/tickets${toQuery(p)}`, t);
export const getAdminTicket = (t: string, id: string) =>
  adminRequest<AdminTicketDetail>(`/support/tickets/${id}`, t);
export const listTicketAssignees = (t: string) =>
  adminRequest<Array<{ id: string; name: string | null; canHandleGeneral: boolean }>>(
    '/support/assignees',
    t,
  );
export const replyToTicket = (t: string, id: string, body: AdminReplyBody) =>
  post<AdminTicketDetail>(`/support/tickets/${id}/reply`, t, body);
export const attachToTicket = (t: string, id: string, form: FormData) =>
  adminUpload<AdminTicketDetail>(`/support/tickets/${id}/attachments`, t, form);
export const addTicketNote = (t: string, id: string, body: AdminNoteBody) =>
  post<AdminTicketDetail>(`/support/tickets/${id}/notes`, t, body);
export const setTicketStatus = (t: string, id: string, body: AdminStatusBody) =>
  post<AdminTicketDetail>(`/support/tickets/${id}/status`, t, body);
export const assignTicket = (t: string, id: string, body: AdminAssignBody) =>
  post<AdminTicketDetail>(`/support/tickets/${id}/assign`, t, body);
export const setTicketPriority = (t: string, id: string, body: AdminPriorityBody) =>
  post<AdminTicketDetail>(`/support/tickets/${id}/priority`, t, body);
export const raiseRefund = (t: string, ticketId: string, body: AdminRefundCreateBody) =>
  post<RefundInfo>(`/support/tickets/${ticketId}/refunds`, t, body);
export const actOnRefundRequest = (t: string, refundId: string, body: AdminRefundActionBody) =>
  post<RefundInfo>(`/support/refunds/${refundId}/action`, t, body);
export const getSupportAttachmentUrl = (t: string, id: string) =>
  adminRequest<{ url: string; expiresInSeconds: number }>(
    `/support/attachments/${id}/download-url`,
    t,
  );
export const getSupportConfig = (t: string) =>
  adminRequest<{ categories: SupportCategory[]; priorities: SupportPriority[] }>(
    '/support/config',
    t,
  );
export const updateSupportCategory = (t: string, code: string, body: Record<string, unknown>) =>
  adminRequest<SupportCategory>(`/support/categories/${code}`, t, { method: 'PATCH', body });
export const updateSupportPriority = (t: string, code: string, body: Record<string, unknown>) =>
  adminRequest<SupportPriority>(`/support/priorities/${code}`, t, { method: 'PATCH', body });

// ---- compliance (COMPLIANCE_MANAGE)
export const listPolicies = (t: string) => adminRequest<PolicyInfo[]>('/compliance/policies', t);
export const publishPolicy = (t: string, key: string, body: PublishPolicyBody) =>
  post<PolicyInfo>(`/compliance/policies/${key}/publish`, t, body);
export const listDataRequests = (
  t: string,
  p: { status?: string; kind?: string; open?: string; page?: number; pageSize?: number },
) =>
  adminRequest<{ items: AdminDataRequestRow[]; total: number }>(
    `/compliance/data-requests${toQuery(p)}`,
    t,
  );
export const actOnDataRequestById = (t: string, id: string, body: DataRequestActionBody) =>
  post<DataRequestInfo>(`/compliance/data-requests/${id}/action`, t, body);
export const listRetention = (t: string) =>
  adminRequest<RetentionPolicyInfo[]>('/compliance/retention', t);
export const updateRetentionRule = (
  t: string,
  type: RetentionRecordType,
  body: UpdateRetentionBody,
) =>
  adminRequest<RetentionPolicyInfo>(`/compliance/retention/${type}`, t, { method: 'PATCH', body });
export const getUserComplianceRecords = (t: string, userId: string) =>
  adminRequest<ComplianceRecordInfo[]>(`/compliance/users/${userId}/records`, t);

// ---- advanced operations (OPERATIONS_VIEW to read, DISPATCH_MANAGE to change)
export const getHeatmap = (t: string) => adminRequest<HeatmapData>('/operations/heatmap', t);
export const getOperationOptions = (t: string) =>
  adminRequest<{
    zones: Array<{ id: string; name: string; isActive: boolean }>;
    categories: Array<{ id: string; label: string }>;
  }>('/operations/options', t);
export const listZones = (t: string) => adminRequest<ZoneDef[]>('/operations/zones', t);
export const saveZone = (t: string, id: string | null, body: AdminZoneBody) =>
  adminRequest<ZoneDef>(id ? `/operations/zones/${id}` : '/operations/zones', t, {
    method: id ? 'PUT' : 'POST',
    body,
  });
export const listPricingRules = (t: string) =>
  adminRequest<PricingRuleInfo[]>('/operations/pricing-rules', t);
export const savePricingRule = (t: string, id: string | null, body: AdminPricingRuleBody) =>
  adminRequest<PricingRuleInfo>(
    id ? `/operations/pricing-rules/${id}` : '/operations/pricing-rules',
    t,
    { method: id ? 'PUT' : 'POST', body },
  );
export const listIncentiveRules = (t: string) =>
  adminRequest<IncentiveRuleInfo[]>('/operations/incentive-rules', t);
export const saveIncentiveRule = (t: string, id: string | null, body: AdminIncentiveRuleBody) =>
  adminRequest<IncentiveRuleInfo>(
    id ? `/operations/incentive-rules/${id}` : '/operations/incentive-rules',
    t,
    { method: id ? 'PUT' : 'POST', body },
  );
export const listIncentiveAwards = (t: string, p: { page?: number; pageSize?: number }) =>
  adminRequest<{ items: IncentiveAwardRow[]; total: number; totalAwardedNpr: number }>(
    `/operations/incentive-awards${toQuery(p)}`,
    t,
  );

// ---- fleets, vehicles and driver operations (FLEET_VIEW to read, FLEET_MANAGE to change)
type Page<T> = { items: T[]; total: number };
export const getFleetOptions = (t: string) =>
  adminRequest<{
    fleets: Array<{ id: string; name: string }>;
    categories: Array<{ id: string; label: string }>;
  }>('/fleet/options', t);
export const listFleetsApi = (t: string) => adminRequest<FleetInfo[]>('/fleet/fleets', t);
export const getFleet = (t: string, id: string) =>
  adminRequest<FleetDetail>(`/fleet/fleets/${id}`, t);
export const saveFleet = (t: string, id: string | null, body: AdminFleetBody) =>
  adminRequest<FleetDetail>(id ? `/fleet/fleets/${id}` : '/fleet/fleets', t, {
    method: id ? 'PUT' : 'POST',
    body,
  });
export const listFleetVehiclesApi = (
  t: string,
  p: {
    fleetId?: string;
    lifecycle?: string;
    assigned?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  },
) => adminRequest<Page<FleetVehicleRow>>(`/fleet/vehicles${toQuery(p)}`, t);
export const getFleetVehicle = (t: string, id: string) =>
  adminRequest<FleetVehicleDetail>(`/fleet/vehicles/${id}`, t);
export const createFleetVehicleApi = (t: string, body: AdminFleetVehicleBody) =>
  post<FleetVehicleDetail>('/fleet/vehicles', t, body);
export const setVehicleLifecycle = (t: string, id: string, body: AdminLifecycleBody) =>
  post<FleetVehicleDetail>(`/fleet/vehicles/${id}/lifecycle`, t, body);
export const assignVehicleApi = (t: string, id: string, driverId: string) =>
  post<FleetVehicleDetail>(`/fleet/vehicles/${id}/assign`, t, { driverId });
export const unassignVehicleApi = (t: string, id: string, reason: string) =>
  post<FleetVehicleDetail>(`/fleet/vehicles/${id}/unassign`, t, { reason });
export const startMaintenanceApi = (t: string, id: string, body: AdminMaintenanceStartBody) =>
  post<ServiceRecordInfo>(`/fleet/vehicles/${id}/maintenance`, t, body);
export const completeMaintenanceApi = (t: string, id: string, body: AdminMaintenanceCompleteBody) =>
  post<ServiceRecordInfo>(`/fleet/service-records/${id}/complete`, t, body);
export const recordInspectionApi = (t: string, id: string, body: AdminInspectionBody) =>
  post<ServiceRecordInfo>(`/fleet/vehicles/${id}/inspections`, t, body);
export const logServiceApi = (t: string, id: string, body: AdminServiceLogBody) =>
  post<ServiceRecordInfo>(`/fleet/vehicles/${id}/services`, t, body);
export const listServiceRecordsApi = (
  t: string,
  p: { status?: string; page?: number; pageSize?: number },
) => adminRequest<Page<ServiceRecordInfo>>(`/fleet/service-records${toQuery(p)}`, t);
export const listFleetDriversApi = (
  t: string,
  p: { fleetId?: string; operational?: string; search?: string; page?: number; pageSize?: number },
) => adminRequest<Page<FleetDriverRow>>(`/fleet/drivers${toQuery(p)}`, t);
export const getFleetDriver = (t: string, id: string) =>
  adminRequest<FleetDriverDetail>(`/fleet/drivers/${id}`, t);
export const setDriverOperational = (t: string, id: string, body: AdminOperationalBody) =>
  post<FleetDriverDetail>(`/fleet/drivers/${id}/operational`, t, body);
export const setDriverFleetApi = (
  t: string,
  id: string,
  body: { fleetId: string | null; reason: string },
) => post<FleetDriverDetail>(`/fleet/drivers/${id}/fleet`, t, body);
export const listExpiring = (t: string, p: { state?: string; kind?: string; fleetId?: string }) =>
  adminRequest<ExpiryItem[]>(`/fleet/expiring${toQuery(p)}`, t);
export const getFleetHistory = (t: string, p: { page?: number; pageSize?: number }) =>
  adminRequest<Page<AuditEntry & { subjectType: string; subjectId: string | null }>>(
    `/fleet/history${toQuery(p)}`,
    t,
  );
export const runFleetCheck = (t: string) =>
  post<{ reminders: number; takenOffline: number; lifted: number }>('/fleet/monitor/run', t);

// ---- fraud and risk (RISK_VIEW to read, RISK_MANAGE to change)

export const getRiskOverview = (t: string) => adminRequest<RiskOverview>('/risk/overview', t);
export const listRiskEvents = (
  t: string,
  p: {
    status?: string;
    category?: string;
    userId?: string;
    tripId?: string;
    page?: number;
    pageSize?: number;
  },
) => adminRequest<Page<RiskEventInfo>>(`/risk/events${toQuery(p)}`, t);
export const getRiskEvent = (t: string, id: string) =>
  adminRequest<RiskEventInfo>(`/risk/events/${id}`, t);
export const reviewRiskEvent = (t: string, id: string, body: AdminRiskReviewBody) =>
  post<RiskEventInfo>(`/risk/events/${id}/review`, t, body);
export const listRiskUsersApi = (
  t: string,
  p: { level?: string; search?: string; page?: number; pageSize?: number },
) => adminRequest<Page<RiskUserRow>>(`/risk/users${toQuery(p)}`, t);
export const getRiskUser = (t: string, id: string) =>
  adminRequest<RiskUserDetail>(`/risk/users/${id}`, t);
export const getRiskTrip = (t: string, id: string) =>
  adminRequest<RiskTripDetail>(`/risk/trips/${id}`, t);
export const restrictRiskUser = (t: string, id: string, body: AdminRiskRestrictBody) =>
  post<RiskRestrictionInfo>(`/risk/users/${id}/restrict`, t, body);
export const liftRiskRestriction = (t: string, id: string, reason: string) =>
  post<{ lifted: true }>(`/risk/users/${id}/lift`, t, { reason });
export const addRiskNote = (t: string, body: AdminRiskNoteBody) =>
  post<RiskNoteInfo>('/risk/notes', t, body);
export const listRiskRules = (t: string) => adminRequest<RiskRuleInfo[]>('/risk/rules', t);
export const saveRiskRule = (t: string, code: string, body: AdminRiskRuleBody) =>
  adminRequest<RiskRuleInfo>(`/risk/rules/${code}`, t, { method: 'PUT', body });
export const getRiskHistory = (t: string, p: { page?: number; pageSize?: number }) =>
  adminRequest<Page<AuditEntry & { subjectType: string; subjectId: string | null }>>(
    `/risk/history${toQuery(p)}`,
    t,
  );
export const runRiskSweepApi = (t: string) => post<RiskSweepResult>('/risk/sweep/run', t);

// ---- business accounts, from the platform's side (ORGANIZATIONS_VIEW to read, ORGANIZATIONS_MANAGE to change)

export const listOrganizationsApi = (
  t: string,
  p: { status?: string; search?: string; page?: number; pageSize?: number },
) => adminRequest<Page<AdminOrganizationRow>>(`/organizations${toQuery(p)}`, t);
export const getOrganizationApi = (t: string, id: string) =>
  adminRequest<AdminOrganizationDetail>(`/organizations/${id}`, t);
export const moveOrganizationApi = (
  t: string,
  id: string,
  to: 'ACTIVE' | 'SUSPENDED',
  reason: string,
) => post<AdminOrganizationDetail>(`/organizations/${id}/status`, t, { to, reason });
export const listOrgStatementsApi = (
  t: string,
  p: { status?: string; organizationId?: string; page?: number; pageSize?: number },
) => adminRequest<Page<AdminStatementRow>>(`/organizations/statements${toQuery(p)}`, t);
export const getOrgStatementApi = (t: string, id: string) =>
  adminRequest<OrgStatementDetail>(`/organizations/statements/${id}`, t);
export const issueStatementsApi = (t: string, periodKey?: string) =>
  post<AdminStatementRunResult>(
    '/organizations/statements/issue',
    t,
    periodKey ? { periodKey } : {},
  );
export const markStatementPaidApi = (t: string, id: string, body: AdminMarkStatementPaidBody) =>
  post<OrgStatementDetail>(`/organizations/statements/${id}/paid`, t, body);
export const voidStatementApi = (t: string, id: string, reason: string) =>
  post<OrgStatementDetail>(`/organizations/statements/${id}/void`, t, { reason });

// ---- cities (OPERATIONS_VIEW to read, DISPATCH_MANAGE to change)

export const listCitiesApi = (t: string) => adminRequest<AdminCityRow[]>('/cities', t);
export const getCityApi = (t: string, id: string) => adminRequest<CityDetail>(`/cities/${id}`, t);
export const createCityApi = (t: string, body: AdminCityBody) =>
  post<CityDetail>('/cities', t, body);
/** One edit of a city: `part` is '' (the profile), '/status', '/hours', '/categories', '/payments', '/settings', '/documents' or '/zones'. */
export const putCityApi = (t: string, id: string, part: string, body: object) =>
  adminRequest<CityDetail>(`/cities/${id}${part}`, t, { method: 'PUT', body });
export const getCityAnalyticsApi = (t: string, id: string, range: string) =>
  adminRequest<CityAnalytics>(`/cities/${id}/analytics?range=${range}`, t);

// ---- background jobs (OPERATIONS_VIEW to read, SETTINGS_MANAGE to run one)

export const listJobsApi = (t: string) => adminRequest<JobInfo[]>('/jobs', t);
export const runJobApi = (t: string, name: string) =>
  post<{ status: string; message: string }>(`/jobs/${encodeURIComponent(name)}/run`, t, {});

// ---- accessible rides (ACCESSIBILITY_VIEW to read, ACCESSIBILITY_MANAGE to change)

export const getAccessibilityStatsApi = (t: string) =>
  adminRequest<AccessibilityStats>('/accessibility/stats?range=30d', t);
export const listAttributesApi = (t: string) =>
  adminRequest<VehicleAttributeInfo[]>('/accessibility/attributes', t);
export const listAccessibilityReviewsApi = (t: string) =>
  adminRequest<AdminCapabilityReview[]>('/accessibility/reviews', t);
export const saveAttributeApi = (t: string, body: AdminAttributeBody) =>
  body.code
    ? adminRequest<VehicleAttributeInfo>(
        `/accessibility/attributes/${encodeURIComponent(body.code)}`,
        t,
        { method: 'PUT', body },
      )
    : post<VehicleAttributeInfo>('/accessibility/attributes', t, body);
export const decideCapabilityApi = (
  t: string,
  vehicleId: string,
  code: string,
  body: AdminCapabilityDecisionBody,
) =>
  post<{ decided: true }>(
    `/accessibility/reviews/${vehicleId}/${encodeURIComponent(code)}`,
    t,
    body,
  );

// ---- route and arrival-time figures (OPERATIONS_VIEW)

export const getNavigationMetricsApi = (t: string) =>
  adminRequest<NavigationMetrics>('/navigation/metrics?range=7d', t);
