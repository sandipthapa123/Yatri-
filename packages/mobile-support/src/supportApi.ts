import { authApi, type PickedFile } from '@yatri/mobile-auth';
import type {
  AcceptPolicyBody,
  ComplianceRecordInfo,
  CreateDataRequestBody,
  CreateTicketBody,
  DataRequestInfo,
  MyPolicyStatus,
  RefundInfo,
  RefundQuote,
  RefundRequestBody,
  SupportCategory,
  TicketDetail,
  TicketInfo,
} from '@yatri/types';

/**
 * The only place the apps talk to the support and compliance endpoints. Every call is scoped to the
 * signed-in person by the server; nothing here decides a status, an amount or a legal move.
 */
type Token = string;
const get = <T>(path: string, accessToken: Token) => authApi.request<T>(path, { accessToken });
const post = <T>(path: string, accessToken: Token, body?: object) =>
  authApi.request<T>(path, { method: 'POST', accessToken, body });

export const supportApi = {
  categories: (t: Token) => get<SupportCategory[]>('/support/categories', t),
  tickets: (t: Token, tripId?: string) =>
    get<TicketInfo[]>(
      `/support/tickets${tripId ? `?tripId=${encodeURIComponent(tripId)}` : ''}`,
      t,
    ),
  ticket: (t: Token, id: string) => get<TicketDetail>(`/support/tickets/${id}`, t),
  create: (t: Token, body: CreateTicketBody) => post<TicketInfo>('/support/tickets', t, body),
  reply: (t: Token, id: string, body: string) =>
    post<TicketDetail>(`/support/tickets/${id}/replies`, t, { body }),
  /** A photo, screenshot or PDF, with an optional message that travels with it. */
  attach: (t: Token, id: string, file: PickedFile, body?: string) => {
    const form = new FormData();
    if (body) form.append('body', body);
    // React Native's FormData accepts { uri, name, type } for a file part.
    form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
    return authApi.requestMultipart<TicketDetail>(`/support/tickets/${id}/attachments`, t, form);
  },
  close: (t: Token, id: string) => post<TicketDetail>(`/support/tickets/${id}/close`, t),
  refundQuote: (t: Token, id: string) => get<RefundQuote>(`/support/tickets/${id}/refund-quote`, t),
  requestRefund: (t: Token, id: string, body: RefundRequestBody) =>
    post<RefundInfo>(`/support/tickets/${id}/refund`, t, body),
  fileUrl: (t: Token, attachmentId: string) =>
    get<{ url: string; expiresInSeconds: number }>(
      `/support/attachments/${attachmentId}/download-url`,
      t,
    ),

  // ---- policies, consent and privacy requests
  policies: (t: Token) => get<MyPolicyStatus[]>('/compliance/policies', t),
  accept: (t: Token, body: AcceptPolicyBody) =>
    post<ComplianceRecordInfo>('/compliance/accept', t, body),
  dataRequests: (t: Token) => get<DataRequestInfo[]>('/compliance/data-requests', t),
  requestData: (t: Token, body: CreateDataRequestBody) =>
    post<DataRequestInfo>('/compliance/data-requests', t, body),
  cancelDataRequest: (t: Token, id: string) =>
    post<DataRequestInfo>(`/compliance/data-requests/${id}/cancel`, t),
  dataCopy: (t: Token, id: string) =>
    get<Record<string, unknown>>(`/compliance/data-requests/${id}/export`, t),
};
export type SupportApi = typeof supportApi;
