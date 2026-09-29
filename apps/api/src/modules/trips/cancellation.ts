import type { TripStatus } from '@yatri/types';

import { env } from '../../config/env';
import { HttpError } from '../../middleware/errorHandler';

/**
 * THE cancellation rules. One pure function decides whether a cancellation is allowed and what it
 * costs; the service applies it and records the result, and the apps only display the fee they are
 * told. Nothing about who may cancel, from which state, or what it costs exists anywhere else.
 *
 * (Which STATES can move to CANCELLED is the state machine's business — trip-machine.ts. This module
 * adds the rules the machine cannot express: a ride under way is not cancellable, and the fee.)
 */
export interface CancellationRules {
  /** Cancelling within this long of a driver being assigned is free. */
  freeSeconds: number;
  /** Fee recorded for a later cancellation; 0 = no fee. */
  feeNpr: number;
}

export const cancellationRules = (): CancellationRules => ({
  freeSeconds: env.CANCEL_FREE_SECONDS,
  feeNpr: env.CANCEL_FEE_NPR,
});

export interface CancellationDecision {
  allowed: boolean;
  /** Only when not allowed: code and words for the refusal. */
  refusal?: { code: string; message: string };
  feeNpr: number;
}

export function decidePassengerCancellation(
  trip: { status: TripStatus; matchedAt: Date | null },
  now: Date,
  rules: CancellationRules = cancellationRules(),
): CancellationDecision {
  switch (trip.status) {
    case 'SEARCHING':
      return { allowed: true, feeNpr: 0 }; // nobody has committed to this ride yet
    case 'DRIVER_EN_ROUTE':
    case 'DRIVER_ARRIVED': {
      const sinceAssigned = trip.matchedAt ? (now.getTime() - trip.matchedAt.getTime()) / 1000 : 0;
      return { allowed: true, feeNpr: sinceAssigned <= rules.freeSeconds ? 0 : rules.feeNpr };
    }
    case 'IN_PROGRESS':
      return {
        allowed: false,
        refusal: {
          code: 'CANNOT_CANCEL_IN_PROGRESS',
          message: 'A ride in progress cannot be cancelled. Contact support if there is a problem.',
        },
        feeNpr: 0,
      };
    default:
      return {
        allowed: false,
        refusal: { code: 'INVALID_STATE_TRANSITION', message: 'This ride has already ended.' },
        feeNpr: 0,
      };
  }
}

/** Throws the standard 409 when the decision refuses; otherwise returns the fee to record. */
export function requireCancellationAllowed(decision: CancellationDecision): number {
  if (!decision.allowed) {
    const r = decision.refusal ?? { code: 'INVALID_STATE_TRANSITION', message: 'Cannot cancel.' };
    throw new HttpError(409, r.code, r.message);
  }
  return decision.feeNpr;
}
