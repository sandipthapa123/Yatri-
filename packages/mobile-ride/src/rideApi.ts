import { authApi } from '@yatri/mobile-auth';
import type {
  CallInfo,
  ChatHistory,
  ChatMessage,
  DisputeInfo,
  FareEstimateResponse,
  IceServersResponse,
  PaymentInfo,
  RatingInput,
  TripHistoryPage,
  TripOfferInfo,
  TripRequestBody,
  TripSummary,
} from '@yatri/types';

/**
 * The only place the apps talk to the trips, chat and call endpoints. Every call is
 * participant-scoped by the server; nothing here decides who may do what.
 * (Live snapshot and event list are in @yatri/mobile-location's tripsApi, next to the socket
 * that needs them.)
 */
type Token = string;
const get = <T>(path: string, accessToken: Token) => authApi.request<T>(path, { accessToken });
const post = <T>(path: string, accessToken: Token, body?: object) =>
  authApi.request<T>(path, { method: 'POST', accessToken, body });

export const rideApi = {
  // ---- passenger
  estimate: (t: Token, body: TripRequestBody) =>
    post<FareEstimateResponse>('/trips/estimate', t, body),
  request: (t: Token, body: TripRequestBody) => post<TripSummary>('/trips/request', t, body),

  // ---- driver: offers and trip actions
  currentOffer: (t: Token) => get<TripOfferInfo | null>('/trips/offers/current', t),
  respondToOffer: (t: Token, offerId: string, accept: boolean) =>
    post<{ accepted: boolean; trip: TripSummary | null }>(
      `/trips/offers/${offerId}/${accept ? 'accept' : 'decline'}`,
      t,
    ),
  arrived: (t: Token, id: string) => post<TripSummary>(`/trips/${id}/arrived`, t),
  start: (t: Token, id: string) => post<TripSummary>(`/trips/${id}/start`, t),
  complete: (t: Token, id: string) => post<TripSummary>(`/trips/${id}/complete`, t),
  noShow: (t: Token, id: string) => post<TripSummary>(`/trips/${id}/no-show`, t),
  confirmPayment: (t: Token, id: string) => post<PaymentInfo>(`/trips/${id}/payment/confirm`, t),

  // ---- both
  active: (t: Token) => get<TripSummary | null>('/trips/active', t),
  trip: (t: Token, id: string) => get<TripSummary>(`/trips/${id}`, t),
  history: (t: Token, page = 1, pageSize = 20) =>
    get<TripHistoryPage>(`/trips/history?page=${page}&pageSize=${pageSize}`, t),
  cancel: (t: Token, id: string, reason?: string) =>
    post<TripSummary>(`/trips/${id}/cancel`, t, reason ? { reason } : {}),
  payment: (t: Token, id: string) => get<PaymentInfo>(`/trips/${id}/payment`, t),
  rate: (t: Token, id: string, rating: RatingInput) =>
    post<{ id: string; tripId: string; stars: number }>(`/trips/${id}/rating`, t, rating),
  dispute: (t: Token, id: string, reason: string) =>
    post<DisputeInfo>(`/trips/${id}/disputes`, t, { reason }),
  disputes: (t: Token, id: string) => get<DisputeInfo[]>(`/trips/${id}/disputes`, t),

  // ---- chat (REST is the reliable path; the socket pushes what others send)
  chatHistory: (t: Token, id: string) => get<ChatHistory>(`/trips/${id}/chat`, t),
  chatSend: (t: Token, id: string, clientMessageId: string, body: string) =>
    post<ChatMessage>(`/trips/${id}/chat`, t, { clientMessageId, body }),
  chatRead: (t: Token, id: string, upToSeq: number) =>
    post<{ upToSeq: number }>(`/trips/${id}/chat/read`, t, { upToSeq }),

  // ---- calls (signalling itself travels over the socket)
  activeCall: (t: Token, id: string) => get<CallInfo | null>(`/trips/${id}/calls/active`, t),
  iceServers: (t: Token, id: string) => get<IceServersResponse>(`/trips/${id}/calls/ice`, t),
};

export type RideApi = typeof rideApi;
