import { authApi } from '@yatri/mobile-auth';
import type {
  ChangeMemberBody,
  CostCenterBody,
  CreateOrganizationBody,
  DecideApprovalBody,
  InviteMemberBody,
  OrgActivityEntry,
  OrgApprovalInfo,
  OrgApprovalStatus,
  OrgBookingBody,
  OrgBookingPreview,
  OrgBookingResult,
  OrgCostCenterInfo,
  OrgInvitationInfo,
  OrgMemberInfo,
  OrgPolicy,
  OrgPolicyView,
  OrgRideRow,
  OrgStatementDetail,
  OrgStatementInfo,
  OrgUsageReport,
  OrganizationInfo,
} from '@yatri/types';

/**
 * The only place the app talks to the organization endpoints. Every call is scoped by the server to the
 * signed-in person and their role in that organization; nothing here decides a permission, a limit or an amount.
 */
type Token = string;
const get = <T>(path: string, accessToken: Token) => authApi.request<T>(path, { accessToken });
const send = <T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  accessToken: Token,
  body?: object,
) => authApi.request<T>(path, { method, accessToken, ...(body ? { body } : {}) });

const org = (id: string) => `/organizations/${id}`;

export const businessApi = {
  mine: (t: Token) => get<OrganizationInfo[]>('/organizations', t),
  invitations: (t: Token) => get<OrgInvitationInfo[]>('/organizations/invitations', t),
  create: (t: Token, body: CreateOrganizationBody) =>
    send<OrganizationInfo>('POST', '/organizations', t, body),
  answerInvitation: (t: Token, orgId: string, accept: boolean) =>
    send<{ accepted: boolean }>(
      'POST',
      `/organizations/invitations/${orgId}/${accept ? 'accept' : 'decline'}`,
      t,
    ),
  get: (t: Token, orgId: string) => get<OrganizationInfo>(org(orgId), t),
  activity: (t: Token, orgId: string) => get<OrgActivityEntry[]>(`${org(orgId)}/activity`, t),

  members: (t: Token, orgId: string) => get<OrgMemberInfo[]>(`${org(orgId)}/members`, t),
  invite: (t: Token, orgId: string, body: InviteMemberBody) =>
    send<{ message: string }>('POST', `${org(orgId)}/members`, t, body),
  changeMember: (t: Token, orgId: string, memberId: string, body: ChangeMemberBody) =>
    send<OrgMemberInfo[]>('PATCH', `${org(orgId)}/members/${memberId}`, t, body),
  removeMember: (t: Token, orgId: string, memberId: string) =>
    send<{ removed: true }>('DELETE', `${org(orgId)}/members/${memberId}`, t),
  leave: (t: Token, orgId: string) => send<{ left: true }>('POST', `${org(orgId)}/leave`, t),

  policy: (t: Token, orgId: string) => get<OrgPolicyView>(`${org(orgId)}/policy`, t),
  savePolicy: (t: Token, orgId: string, body: OrgPolicy) =>
    send<OrgPolicyView>('PUT', `${org(orgId)}/policy`, t, body),
  costCenters: (t: Token, orgId: string) =>
    get<OrgCostCenterInfo[]>(`${org(orgId)}/cost-centers`, t),
  addCostCenter: (t: Token, orgId: string, body: CostCenterBody) =>
    send<OrgCostCenterInfo>('POST', `${org(orgId)}/cost-centers`, t, body),
  saveCostCenter: (t: Token, orgId: string, id: string, body: CostCenterBody) =>
    send<OrgCostCenterInfo>('PUT', `${org(orgId)}/cost-centers/${id}`, t, body),

  preview: (t: Token, orgId: string, body: OrgBookingBody) =>
    send<OrgBookingPreview>('POST', `${org(orgId)}/bookings/preview`, t, body),
  book: (t: Token, orgId: string, body: OrgBookingBody) =>
    send<OrgBookingResult>('POST', `${org(orgId)}/bookings`, t, body),
  approvals: (t: Token, orgId: string, status?: OrgApprovalStatus) =>
    get<OrgApprovalInfo[]>(`${org(orgId)}/approvals${status ? `?status=${status}` : ''}`, t),
  decide: (t: Token, orgId: string, approvalId: string, body: DecideApprovalBody) =>
    send<OrgApprovalInfo>('POST', `${org(orgId)}/approvals/${approvalId}/decision`, t, body),
  cancelApproval: (t: Token, orgId: string, approvalId: string) =>
    send<OrgApprovalInfo>('POST', `${org(orgId)}/approvals/${approvalId}/cancel`, t),

  rides: (t: Token, orgId: string, page = 1) =>
    get<{ items: OrgRideRow[]; total: number }>(`${org(orgId)}/rides?page=${page}&pageSize=20`, t),
  usage: (t: Token, orgId: string, range: '7d' | '30d' | '90d') =>
    get<OrgUsageReport>(`${org(orgId)}/reports/usage?range=${range}`, t),
  statements: (t: Token, orgId: string) => get<OrgStatementInfo[]>(`${org(orgId)}/statements`, t),
  statement: (t: Token, orgId: string, id: string) =>
    get<OrgStatementDetail>(`${org(orgId)}/statements/${id}`, t),
};
export type BusinessApi = typeof businessApi;
