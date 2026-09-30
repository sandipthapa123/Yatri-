import type { RefundQuote, RefundReason } from '@yatri/types';

/**
 * THE refund calculation, beside the fare rules it depends on. Nothing else works out what a refund may
 * be: the passenger's request, the admin's action and the figures an admin sees all call `quoteRefund`.
 *
 * A payment is never edited. What has been refunded is the sum of COMPLETED refunds on it; what may still
 * be refunded is what was paid minus that. Whole rupees only (the platform's money is whole rupees).
 */
export interface RefundBasis {
  /** What was paid for the ride (trip_payments.amount_npr) - only ever for a PAID payment. */
  paidNpr: number;
  /** The sum of this payment's COMPLETED refunds. */
  refundedNpr: number;
  /** The waiting charge that is part of the fare (trips.waiting_charge_npr). */
  waitingChargeNpr: number;
}

export function quoteRefund(basis: RefundBasis): RefundQuote {
  const remaining = Math.max(0, basis.paidNpr - basis.refundedNpr);
  const waiting = Math.min(Math.max(0, basis.waitingChargeNpr), remaining);
  return {
    paidNpr: basis.paidNpr,
    refundedNpr: basis.refundedNpr,
    remainingNpr: remaining,
    waitingChargeNpr: basis.waitingChargeNpr,
    amounts: {
      // The whole fare only while nothing has been paid back yet.
      FULL_FARE: basis.refundedNpr === 0 && remaining > 0 ? remaining : null,
      WAITING_CHARGE: waiting > 0 ? waiting : null,
      // Any amount up to what is left: the caller supplies it, the figure here is the ceiling.
      PARTIAL: remaining > 0 ? remaining : null,
    },
  };
}

export type RefundAmountCheck = { ok: true; amountNpr: number } | { ok: false; message: string };

/** The amount a request for `reason` comes to, or why it cannot be granted. */
export function refundAmountFor(
  quote: RefundQuote,
  reason: RefundReason,
  requestedNpr: number | undefined,
): RefundAmountCheck {
  if (quote.remainingNpr <= 0) {
    return { ok: false, message: 'Everything paid for this ride has already been refunded.' };
  }
  if (reason === 'PARTIAL') {
    if (requestedNpr === undefined || !Number.isInteger(requestedNpr) || requestedNpr < 1) {
      return { ok: false, message: 'Enter the amount to refund in whole rupees.' };
    }
    if (requestedNpr > quote.remainingNpr) {
      return {
        ok: false,
        message: `The most that can be refunded is NPR ${quote.remainingNpr}.`,
      };
    }
    return { ok: true, amountNpr: requestedNpr };
  }
  const amount = quote.amounts[reason];
  if (amount === null) {
    return {
      ok: false,
      message:
        reason === 'FULL_FARE'
          ? 'The whole fare cannot be refunded because part of it was already paid back.'
          : 'There was no waiting charge on this ride.',
    };
  }
  return { ok: true, amountNpr: amount };
}
