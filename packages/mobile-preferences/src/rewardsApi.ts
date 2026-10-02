import { authApi } from '@yatri/mobile-auth';
import type { OfferView, ReferralView, RewardsHistoryResponse, RewardsSummary } from '@yatri/types';

/**
 * The only place the passenger app talks to the offers, rewards and invites endpoints. The server decides what an
 * offer is, what a code does and what a point is worth; nothing here (or in any screen) works out an amount.
 */
type Token = string;
export const rewardsApi = {
  offers: (t: Token) => authApi.request<OfferView[]>('/growth/offers', { accessToken: t }),
  checkCode: (t: Token, code: string) =>
    authApi.request<{ valid: boolean; offer: OfferView | null; problem: string | null }>(
      '/growth/promo/check',
      {
        method: 'POST',
        accessToken: t,
        body: { code },
      },
    ),
  rewards: (t: Token) => authApi.request<RewardsSummary>('/growth/rewards', { accessToken: t }),
  history: (t: Token, before?: string | null) =>
    authApi.request<RewardsHistoryResponse>(
      `/growth/rewards/history${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      {
        accessToken: t,
      },
    ),
  referral: (t: Token) => authApi.request<ReferralView>('/growth/referral', { accessToken: t }),
  applyReferral: (t: Token, code: string) =>
    authApi.request<{ message: string }>('/growth/referral/apply', {
      method: 'POST',
      accessToken: t,
      body: { code },
    }),
};
export type RewardsApi = typeof rewardsApi;
