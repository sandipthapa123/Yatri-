import {
  LEDGER_KIND_LABELS,
  formatNpr,
  type LedgerEntryInfo,
  type OfferView,
  type PromotionQuote,
  type ReferralView,
  type RewardsSummary,
} from '@yatri/types';

/**
 * The words of the offers, rewards and referral screens, with no framework in them so they are tested. Every amount
 * and every rule comes from the server's answer (the engine and the rules in @yatri/types); this only turns an answer
 * into sentences, and never works out an amount.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function balanceSentence(s: RewardsSummary): string {
  const base = `You have ${plural(s.balance, 'reward point', 'reward points')}, worth ${formatNpr(s.valueNpr)} off a ride.`;
  if (!s.expiringSoon) return base;
  return `${base} ${plural(s.expiringSoon.points, 'point', 'points')} expire on ${new Date(s.expiringSoon.at).toLocaleDateString()}.`;
}

export function howPointsWork(s: RewardsSummary): string {
  const r = s.rules;
  return `You earn ${plural(r.pointsPer100Npr, 'point', 'points')} for every NPR 100 you pay. Each point takes NPR ${r.pointValueNpr} off a ride, once you have at least ${r.minRedeemPoints} points, and points can pay up to ${r.maxRedeemPercent}% of a fare.${r.expireDays > 0 ? ` Points expire ${r.expireDays} days after you earn them.` : ''}`;
}

export function offerLine(o: OfferView): string {
  const when = o.usableUntil
    ? ` Use it by ${new Date(o.usableUntil).toLocaleDateString()}.`
    : o.endsAt
      ? ` Until ${new Date(o.endsAt).toLocaleDateString()}.`
      : '';
  const how = o.automatic
    ? ' Applied automatically when you book.'
    : o.code
      ? ` Code ${o.code}.`
      : ' Given to you.';
  return `${o.name}: ${o.summary}.${how}${when}`;
}

export const NO_OFFERS_TEXT =
  'There are no offers for you right now. When there is one, it will appear here.';

export function codeResultSentence(r: {
  valid: boolean;
  offer: OfferView | null;
  problem: string | null;
}): string {
  if (r.valid && r.offer) {
    return `Code accepted: ${r.offer.summary}. It is applied when you book a ride, if the ride fits its conditions.`;
  }
  return r.problem ?? 'That code could not be used.';
}

export function historyLine(e: LedgerEntryInfo): string {
  const sign = e.points > 0 ? `+${e.points}` : `${e.points}`;
  return `${LEDGER_KIND_LABELS[e.kind]}: ${sign} ${Math.abs(e.points) === 1 ? 'point' : 'points'}. ${e.description}. ${new Date(e.createdAt).toLocaleDateString()}.`;
}

export const NO_HISTORY_TEXT = 'No reward points yet. You earn points on every completed ride.';

export function referralSentences(v: ReferralView): string[] {
  const out = [`Your invite code is ${v.code.split('').join(' ')}.`];
  if (!v.open) out.push('Invites are not open right now. Your code will work again when they are.');
  else {
    out.push(
      `Friends who use it get ${v.friendGets ?? 'a welcome offer'} on their first ride.${v.youEarnPoints ? ` You earn ${plural(v.youEarnPoints, 'point', 'points')} when a friend finishes their first ride.` : ''}`,
    );
  }
  out.push(
    v.invited === 0
      ? 'Nobody has used your code yet.'
      : `${plural(v.invited, 'friend has', 'friends have')} used your code: ${v.rewarded} finished a first ride, ${v.pending} ${v.pending === 1 ? 'is' : 'are'} still to ride.`,
  );
  return out;
}

/**
 * The fare breakdown for a ride, from the server's quote: the lines a rider reads before booking. The same lines appear
 * whether or not an offer applies, so the layout does not change under a screen reader.
 */
export function quoteLines(q: PromotionQuote): Array<{ label: string; value: string }> {
  const lines = [{ label: 'Fare', value: formatNpr(q.fareNpr) }];
  for (const o of q.offers) {
    if (o.discountNpr > 0)
      lines.push({ label: `Offer: ${o.name}`, value: `minus ${formatNpr(o.discountNpr)}` });
    else lines.push({ label: `Offer: ${o.name}`, value: o.description });
  }
  if (q.pointsUsed > 0) {
    lines.push({
      label: `Reward points (${q.pointsUsed} points)`,
      value: `minus ${formatNpr(q.pointsValueNpr)}`,
    });
  }
  lines.push({ label: 'You pay', value: formatNpr(q.payableNpr) });
  if (q.pointsToEarn > 0)
    lines.push({
      label: 'You will earn',
      value: `about ${plural(q.pointsToEarn, 'point', 'points')}`,
    });
  return lines;
}

/** One spoken sentence for the same breakdown ("Fare NPR 237. Offer: ... You pay NPR 164."). */
export function quoteSentence(q: PromotionQuote): string {
  return (
    quoteLines(q)
      .map((l) => `${l.label}: ${l.value}`)
      .join('. ') + '.'
  );
}
