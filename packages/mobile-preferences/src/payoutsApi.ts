import { authApi } from '@yatri/mobile-auth';
import type { DriverPayoutSummary, PayoutAccountBody } from '@yatri/types';

/**
 * The only place the driver app talks to the payouts endpoints. The server decides what is owed, what is held and what a payout
 * is; nothing here works out an amount. The account number is sent once and never kept on the phone.
 */
type Token = string;
export const payoutsApi = {
  summary: (t: Token) =>
    authApi.request<DriverPayoutSummary>('/drivers/me/payouts', { accessToken: t }),
  saveAccount: (t: Token, body: PayoutAccountBody) =>
    authApi.request<DriverPayoutSummary>('/drivers/me/payout-account', {
      method: 'PUT',
      accessToken: t,
      body,
    }),
};
export type PayoutsApi = typeof payoutsApi;
