import { authApi } from '@yatri/mobile-auth';
import type {
  CallInfo,
  GrowthDriverView,
  ChatHistory,
  ChatMessage,
  EmergencyContact,
  EmergencyContactsResponse,
  AccessibilityProfile,
  AccessibilityProfileBody,
  FareEstimateResponse,
  IceServersResponse,
  IncidentBody,
  IncidentInfo,
  PaymentInfo,
  RatingInput,
  RatingSummary,
  ShareCreated,
  ShareInfo,
  SosInfo,
  SosRequestBody,
  TripHistoryPage,
  TripAccessibilityUpdateBody,
  TripEstimateBody,
  TripOfferInfo,
  TripRequestBody,
  TripSummary,
  VehicleCapabilitiesBody,
  VehicleCapabilitiesResponse,
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
/**
 * An action that must not happen twice (see the API's idempotency middleware): sent with an Idempotency-Key, and sent
 * again with the same key if the connection drops before an answer, so it neither duplicates nor gets lost.
 */
const once = <T>(path: string, accessToken: Token, body?: object) =>
  authApi.request<T>(path, { method: 'POST', accessToken, body, idempotent: true });

export const rideApi = {
  // ---- passenger
  estimate: (t: Token, body: TripEstimateBody) =>
    post<FareEstimateResponse>('/trips/estimate', t, body),
  request: (t: Token, body: TripRequestBody) => once<TripSummary>('/trips/request', t, body),

  // ---- driver: offers and trip actions
  currentOffer: (t: Token) => get<TripOfferInfo | null>('/trips/offers/current', t),
  respondToOffer: (t: Token, offerId: string, accept: boolean) =>
    once<{ accepted: boolean; trip: TripSummary | null }>(
      `/trips/offers/${offerId}/${accept ? 'accept' : 'decline'}`,
      t,
    ),
  arrived: (t: Token, id: string) => once<TripSummary>(`/trips/${id}/arrived`, t),
  start: (t: Token, id: string) => once<TripSummary>(`/trips/${id}/start`, t),
  complete: (t: Token, id: string) => once<TripSummary>(`/trips/${id}/complete`, t),
  noShow: (t: Token, id: string) => once<TripSummary>(`/trips/${id}/no-show`, t),
  confirmPayment: (t: Token, id: string) => once<PaymentInfo>(`/trips/${id}/payment/confirm`, t),

  // ---- accessibility (the passenger's own saved needs; a ride's pickup instructions; a vehicle's features)
  accessibilityProfile: (t: Token) => get<AccessibilityProfile>('/users/me/accessibility', t),
  saveAccessibilityProfile: (t: Token, body: AccessibilityProfileBody) =>
    authApi.request<AccessibilityProfile>('/users/me/accessibility', {
      method: 'PUT',
      accessToken: t,
      body,
    }),
  updatePickupAccessibility: (t: Token, id: string, body: TripAccessibilityUpdateBody) =>
    authApi.request<TripSummary>(`/trips/${id}/accessibility`, {
      method: 'PUT',
      accessToken: t,
      body,
    }),
  vehicleCapabilities: (t: Token, vehicleId: string) =>
    get<VehicleCapabilitiesResponse>(`/vehicles/${vehicleId}/accessibility`, t),
  declareVehicleCapabilities: (t: Token, vehicleId: string, body: VehicleCapabilitiesBody) =>
    authApi.request<VehicleCapabilitiesResponse>(`/vehicles/${vehicleId}/accessibility`, {
      method: 'PUT',
      accessToken: t,
      body,
    }),

  // ---- both
  active: (t: Token) => get<TripSummary | null>('/trips/active', t),
  /** The driver's own bonus rules, progress and earnings. */
  incentives: async (t: Token) => (await get<GrowthDriverView>('/growth/driver', t)).incentives,
  trip: (t: Token, id: string) => get<TripSummary>(`/trips/${id}`, t),
  history: (t: Token, page = 1, pageSize = 20) =>
    get<TripHistoryPage>(`/trips/history?page=${page}&pageSize=${pageSize}`, t),
  cancel: (t: Token, id: string, reason?: string) =>
    once<TripSummary>(`/trips/${id}/cancel`, t, reason ? { reason } : {}),
  payment: (t: Token, id: string) => get<PaymentInfo>(`/trips/${id}/payment`, t),
  rate: (t: Token, id: string, rating: RatingInput) =>
    post<{ id: string; tripId: string; stars: number }>(`/trips/${id}/rating`, t, rating),

  // ---- chat (REST is the reliable path; the socket pushes what others send)
  chatHistory: (t: Token, id: string) => get<ChatHistory>(`/trips/${id}/chat`, t),
  chatSend: (t: Token, id: string, clientMessageId: string, body: string) =>
    post<ChatMessage>(`/trips/${id}/chat`, t, { clientMessageId, body }),
  chatRead: (t: Token, id: string, upToSeq: number) =>
    post<{ upToSeq: number }>(`/trips/${id}/chat/read`, t, { upToSeq }),

  // ---- calls (signalling itself travels over the socket)
  activeCall: (t: Token, id: string) => get<CallInfo | null>(`/trips/${id}/calls/active`, t),
  // ---- trip sharing (passenger)
  createShare: (t: Token, id: string) => post<ShareCreated>(`/trips/${id}/shares`, t),
  shares: (t: Token, id: string) => get<ShareInfo[]>(`/trips/${id}/shares`, t),
  stopShare: (t: Token, id: string, shareId: string) =>
    authApi.request<{ stopped: true }>(`/trips/${id}/shares/${shareId}`, {
      method: 'DELETE',
      accessToken: t,
    }),

  // ---- safety: SOS, incident reports, emergency contacts, my rating
  sos: (t: Token, id: string, body: SosRequestBody) => post<SosInfo>(`/trips/${id}/sos`, t, body),
  mySos: (t: Token, id: string) => get<SosInfo | null>(`/trips/${id}/sos`, t),
  cancelSos: (t: Token, id: string) => post<SosInfo>(`/trips/${id}/sos/cancel`, t),
  reportIncident: (t: Token, id: string, body: IncidentBody) =>
    post<IncidentInfo>(`/trips/${id}/incidents`, t, body),
  myIncidents: (t: Token, id: string) => get<IncidentInfo[]>(`/trips/${id}/incidents`, t),
  emergencyContacts: (t: Token) =>
    get<EmergencyContactsResponse>('/users/me/emergency-contacts', t),
  addEmergencyContact: (t: Token, name: string, phoneNumber: string) =>
    post<EmergencyContact>('/users/me/emergency-contacts', t, { name, phoneNumber }),
  removeEmergencyContact: (t: Token, id: string) =>
    authApi.request<{ removed: true }>(`/users/me/emergency-contacts/${id}`, {
      method: 'DELETE',
      accessToken: t,
    }),
  myRating: (t: Token) => get<RatingSummary>('/users/me/rating', t),

  iceServers: (t: Token, id: string) => get<IceServersResponse>(`/trips/${id}/calls/ice`, t),
};

export type RideApi = typeof rideApi;
