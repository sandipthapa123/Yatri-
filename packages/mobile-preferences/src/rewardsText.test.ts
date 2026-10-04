import type {
  LedgerEntryInfo,
  OfferView,
  PromotionQuote,
  ReferralView,
  RewardsSummary,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import {
  balanceSentence,
  codeResultSentence,
  historyLine,
  howPointsWork,
  offerLine,
  quoteLines,
  quoteSentence,
  referralSentences,
} from './rewardsText';

const rules = {
  pointsPer100Npr: 1,
  pointValueNpr: 1,
  expireDays: 365,
  minRedeemPoints: 50,
  maxRedeemPercent: 50,
};
const summary = (over: Partial<RewardsSummary> = {}): RewardsSummary => ({
  balance: 120,
  valueNpr: 120,
  expiringSoon: null,
  rules,
  ...over,
});
const offer = (over: Partial<OfferView> = {}): OfferView => ({
  campaignId: 'c',
  kind: 'PROMO',
  name: 'Weekday rides',
  description: '',
  summary: '10% off your fare, up to NPR 100',
  code: null,
  endsAt: null,
  usableUntil: null,
  automatic: true,
  conditions: [],
  ...over,
});

describe('reward points in words', () => {
  it('says the balance and what it is worth, and warns about points that expire', () => {
    expect(balanceSentence(summary())).toBe(
      'You have 120 reward points, worth NPR 120 off a ride.',
    );
    expect(balanceSentence(summary({ balance: 1, valueNpr: 1 }))).toContain('1 reward point,');
    expect(
      balanceSentence(summary({ expiringSoon: { points: 30, at: '2026-12-01T00:00:00Z' } })),
    ).toContain('30 points expire on');
  });

  it("explains how points work from the server's own rules", () => {
    const text = howPointsWork(summary());
    expect(text).toContain('1 point for every NPR 100');
    expect(text).toContain('at least 50 points');
    expect(text).toContain('up to 50% of a fare');
    expect(text).toContain('365 days');
    expect(howPointsWork(summary({ rules: { ...rules, expireDays: 0 } }))).not.toContain('expire');
  });

  it('words each entry of the history with its sign and reason', () => {
    const e: LedgerEntryInfo = {
      id: 'x',
      kind: 'REDEEM',
      points: -50,
      source: 'RIDE',
      description: 'Used on a ride',
      expiresAt: null,
      createdAt: '2026-06-01T10:00:00Z',
    };
    expect(historyLine(e)).toMatch(/^Used on a ride: -50 points\. Used on a ride\./);
    expect(
      historyLine({ ...e, kind: 'EARN', points: 1, description: 'Earned for a ride' }),
    ).toContain('+1 point.');
  });
});

describe('offers in words', () => {
  it('says how an offer is used and until when', () => {
    expect(offerLine(offer())).toBe(
      'Weekday rides: 10% off your fare, up to NPR 100. Applied automatically when you book.',
    );
    expect(offerLine(offer({ automatic: false, code: 'SAVE20' }))).toContain('Code SAVE20.');
    expect(
      offerLine(offer({ automatic: false, code: null, usableUntil: '2026-07-01T00:00:00Z' })),
    ).toContain('Given to you.');
    expect(offerLine(offer({ usableUntil: '2026-07-01T00:00:00Z' }))).toContain('Use it by');
  });

  it("tells a typed code's result, or why it did not work", () => {
    expect(codeResultSentence({ valid: true, offer: offer(), problem: null })).toContain(
      'Code accepted: 10% off',
    );
    expect(
      codeResultSentence({
        valid: false,
        offer: null,
        problem: 'That code is not valid. Check it and try again.',
      }),
    ).toBe('That code is not valid. Check it and try again.');
    expect(codeResultSentence({ valid: false, offer: null, problem: null })).toBe(
      'That code could not be used.',
    );
  });
});

describe('invites in words', () => {
  const view = (over: Partial<ReferralView> = {}): ReferralView => ({
    code: 'ABCD2345',
    open: true,
    youEarnPoints: 120,
    friendGets: 'NPR 30 off your fare',
    invited: 0,
    rewarded: 0,
    pending: 0,
    shareText: '',
    usedInvite: false,
    referrals: [],
    ...over,
  });
  it('spells the code out and says what each side gets', () => {
    const s = referralSentences(view());
    expect(s[0]).toBe('Your invite code is A B C D 2 3 4 5.');
    expect(s[1]).toContain('NPR 30 off your fare');
    expect(s[1]).toContain('You earn 120 points');
    expect(s[2]).toBe('Nobody has used your code yet.');
  });
  it('says when invites are closed and how friends are doing', () => {
    expect(referralSentences(view({ open: false }))[1]).toContain('not open right now');
    expect(referralSentences(view({ invited: 3, rewarded: 1, pending: 2 }))[2]).toBe(
      '3 friends have used your code: 1 finished a first ride, 2 are still to ride.',
    );
    expect(referralSentences(view({ invited: 1, pending: 1 }))[2]).toContain(
      '1 friend has used your code',
    );
  });
});

describe('the fare breakdown before booking', () => {
  const quote = (over: Partial<PromotionQuote> = {}): PromotionQuote => ({
    fareNpr: 237,
    offers: [
      {
        campaignId: 'c',
        name: 'Weekday rides',
        type: 'PERCENT_OFF',
        discountNpr: 23,
        bonusPoints: 0,
        pointsMultiplier: 1,
        description: '10% off',
        disabilityBenefit: false,
      },
    ],
    discountNpr: 23,
    pointsUsed: 50,
    pointsValueNpr: 50,
    payableNpr: 164,
    pointsToEarn: 1,
    codeProblem: null,
    breakdown: {
      standardFareNpr: 237,
      disabilityBenefitNpr: 0,
      loyaltyBenefitNpr: 50,
      otherDiscountNpr: 23,
      payableNpr: 164,
    },
    ...over,
  });
  it("lists the fare, each offer, points, what you pay and what you will earn, from the server's numbers", () => {
    const lines = quoteLines(quote());
    expect(lines.map((l) => l.label)).toEqual([
      'Fare',
      'Offer: Weekday rides',
      'Reward points (50 points)',
      'You pay',
      'You will earn',
    ]);
    expect(lines[1]?.value).toBe('minus NPR 23');
    expect(lines[3]?.value).toBe('NPR 164');
    expect(quoteSentence(quote())).toBe(
      'Fare: NPR 237. Offer: Weekday rides: minus NPR 23. Reward points (50 points): minus NPR 50. You pay: NPR 164. You will earn: about 1 point.',
    );
  });
  it('shows a points offer without inventing a discount, and omits what does not apply', () => {
    const q = quote({
      offers: [
        {
          campaignId: 'p',
          name: 'Double points',
          type: 'POINTS_MULTIPLIER',
          discountNpr: 0,
          bonusPoints: 0,
          pointsMultiplier: 2,
          description: '2× reward points on the ride',
          disabilityBenefit: false,
        },
      ],
      discountNpr: 0,
      pointsUsed: 0,
      pointsValueNpr: 0,
      payableNpr: 237,
      pointsToEarn: 0,
    });
    const lines = quoteLines(q);
    expect(lines.find((l) => l.label === 'Offer: Double points')?.value).toBe(
      '2× reward points on the ride',
    );
    expect(lines.map((l) => l.label)).toEqual(['Fare', 'Offer: Double points', 'You pay']);
  });

  it('lays a disability benefit out as standard fare, disability benefit, loyalty benefit, other discount and amount payable', () => {
    const q = quote({
      offers: [
        {
          campaignId: 'd',
          name: 'Disability benefit 20%',
          type: 'PERCENT_OFF',
          discountNpr: 47,
          bonusPoints: 0,
          pointsMultiplier: 1,
          description: '20% off your fare',
          disabilityBenefit: true,
        },
        {
          campaignId: 'o',
          name: 'Weekday rides',
          type: 'FIXED_OFF',
          discountNpr: 10,
          bonusPoints: 0,
          pointsMultiplier: 1,
          description: 'NPR 10 off your fare',
          disabilityBenefit: false,
        },
      ],
      discountNpr: 57,
      pointsUsed: 50,
      pointsValueNpr: 50,
      payableNpr: 130,
      breakdown: {
        standardFareNpr: 237,
        disabilityBenefitNpr: 47,
        loyaltyBenefitNpr: 50,
        otherDiscountNpr: 10,
        payableNpr: 130,
      },
    });
    const lines = quoteLines(q);
    expect(lines.map((l) => l.label)).toEqual([
      'Standard fare',
      'Disability benefit',
      'Other discount: Weekday rides',
      'Loyalty benefit (50 points)',
      'Amount payable',
      'You will earn',
    ]);
    expect(lines.find((l) => l.label === 'Disability benefit')?.value).toBe('minus NPR 47');
    expect(lines.find((l) => l.label === 'Amount payable')?.value).toBe('NPR 130');
    // the server's own five figures add up
    const b = q.breakdown;
    expect(
      b.standardFareNpr - b.disabilityBenefitNpr - b.loyaltyBenefitNpr - b.otherDiscountNpr,
    ).toBe(b.payableNpr);
    expect(quoteSentence(q)).toContain('Disability benefit: minus NPR 47');
  });
});
