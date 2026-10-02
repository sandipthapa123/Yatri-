import {
  REFERRAL_CODE_PATTERN,
  type ApiResponse,
  type GrowthDriverView,
  type OfferView,
  type ReferralView,
  type RewardsHistoryResponse,
  type RewardsSummary,
} from '@yatri/types';
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/authenticate';
import { HttpError } from '../../middleware/errorHandler';
import { userMutationRateLimit, userRateLimit } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { validateQuery } from '../../middleware/validateQuery';
import { availableOffers, checkCode } from './engine';
import { driverCampaignView } from './driver';
import { rewardsHistory, rewardsSummary } from './loyalty';
import { applyReferral, referralView } from './referrals';

/**
 * What a signed-in person sees and does about offers, reward points and invites. Everything is the caller's own (the
 * person comes from the session), nothing here decides an amount: the engine answers and the apps show it. A rider
 * gets the rider endpoints; a driver gets the driver view from the same service. Administrators use /admin/growth.
 */
export const growthRouter: RouterType = Router();
growthRouter.use(authenticate, userMutationRateLimit());

type Res<T> = Response<ApiResponse<T>>;
const me = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};

growthRouter.get('/offers', requireRole('PASSENGER'), async (req, res: Res<OfferView[]>) => {
  res.json({ success: true, data: await availableOffers(me(req)) });
});

const codeSchema = z.object({ code: z.string().trim().min(1).max(30) }).strict();
growthRouter.post(
  '/promo/check',
  requireRole('PASSENGER'),
  userRateLimit('promo-check', 20, 600), // a code cannot be guessed by asking again and again
  validateBody(codeSchema),
  async (req, res: Res<{ valid: boolean; offer: OfferView | null; problem: string | null }>) => {
    res.json({
      success: true,
      data: await checkCode(me(req), (req.body as { code: string }).code),
    });
  },
);

growthRouter.get('/rewards', requireRole('PASSENGER'), async (req, res: Res<RewardsSummary>) => {
  res.json({ success: true, data: await rewardsSummary(me(req)) });
});

const historyQuery = z.object({ before: z.string().datetime().optional() });
growthRouter.get(
  '/rewards/history',
  requireRole('PASSENGER'),
  validateQuery(historyQuery),
  async (req, res: Res<RewardsHistoryResponse>) => {
    const q = req.validatedQuery as { before?: string };
    res.json({ success: true, data: await rewardsHistory(me(req), q.before ?? null) });
  },
);

growthRouter.get('/referral', requireRole('PASSENGER'), async (req, res: Res<ReferralView>) => {
  res.json({ success: true, data: await referralView(me(req)) });
});
const applySchema = z
  .object({ code: z.string().trim().toUpperCase().regex(REFERRAL_CODE_PATTERN) })
  .strict();
growthRouter.post(
  '/referral/apply',
  requireRole('PASSENGER'),
  userRateLimit('referral-apply', 10, 3600),
  validateBody(applySchema),
  async (req, res: Res<{ message: string }>) => {
    res.json({
      success: true,
      data: await applyReferral(me(req), (req.body as { code: string }).code),
    });
  },
);

growthRouter.get('/driver', requireRole('DRIVER'), async (req, res: Res<GrowthDriverView>) => {
  res.json({ success: true, data: await driverCampaignView(me(req)) });
});
