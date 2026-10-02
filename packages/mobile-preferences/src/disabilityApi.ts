import { authApi } from '@yatri/mobile-auth';
import type { PickedFile } from '@yatri/mobile-auth';
import type { DisabilityDetailsBody, DisabilityMethod, DisabilityVerificationView } from '@yatri/types';

/**
 * The only place the passenger app talks to the disability benefit verification endpoints. The app asks; the server
 * decides every status. Nothing here (or in any screen) sets or guesses a status, and the card number is sent once and
 * never kept on the phone.
 */
type Token = string;
const BASE = '/me/disability-verification';

export const disabilityApi = {
  get: (t: Token) => authApi.request<DisabilityVerificationView>(BASE, { accessToken: t }),
  optIn: (t: Token, consentVersion: string, method?: DisabilityMethod) =>
    authApi.request<DisabilityVerificationView>(BASE, {
      method: 'POST',
      accessToken: t,
      body: { consentVersion, ...(method ? { method } : {}) },
    }),
  saveDetails: (t: Token, details: DisabilityDetailsBody) =>
    authApi.request<DisabilityVerificationView>(BASE, { method: 'PATCH', accessToken: t, body: { details } }),
  withdraw: (t: Token) =>
    authApi.request<DisabilityVerificationView>(BASE, { method: 'PATCH', accessToken: t, body: { withdrawConsent: true } }),
  uploadDocument: (t: Token, file: PickedFile) => {
    const form = new FormData();
    // React Native's FormData accepts { uri, name, type } for a file part.
    form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
    return authApi.requestMultipart<DisabilityVerificationView>(`${BASE}/documents`, t, form);
  },
  submit: (t: Token, cardNumber?: string) =>
    authApi.request<DisabilityVerificationView>(`${BASE}/submit`, {
      method: 'POST',
      accessToken: t,
      body: cardNumber ? { cardNumber } : {},
    }),
};
export type DisabilityApi = typeof disabilityApi;
