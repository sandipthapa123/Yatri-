import {
  formatElapsed,
  formatNpr,
  type TripRole,
  type TripStatus,
  type TripSummary,
  type WaitingInfo,
} from '@yatri/types';

/**
 * WHICH buttons a person sees for a ride, and the words on them — one definition for both apps.
 * This is presentation only: every action is re-checked by the server, which is the authority on
 * who may do what and when. (A button shown here can still be refused; a button hidden here can
 * never be forced.)
 */
export type RideActionId =
  'cancel' | 'arrived' | 'start' | 'complete' | 'noShow' | 'confirmPayment' | 'rate' | 'dispute';

export interface RideAction {
  id: RideActionId;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
  /** Ask before doing it (irreversible or affects the other person). */
  confirm?: { title: string; message: string };
}

const cancelFor = (role: TripRole, status: TripStatus): RideAction => {
  if (role === 'PASSENGER') {
    return {
      id: 'cancel',
      label: status === 'SEARCHING' ? 'Cancel request' : 'Cancel ride',
      tone: 'danger',
      confirm: {
        title: status === 'SEARCHING' ? 'Cancel this request?' : 'Cancel this ride?',
        message:
          status === 'SEARCHING'
            ? 'We will stop looking for a driver.'
            : 'Your driver will be told the ride was cancelled.',
      },
    };
  }
  return {
    id: 'cancel',
    label: 'Cannot do this ride',
    tone: 'danger',
    confirm: {
      title: 'Drop this ride?',
      message: 'The passenger will be matched with another driver.',
    },
  };
};

export function rideActions(
  role: TripRole,
  trip: { status: TripStatus; paymentStatus: TripSummary['paymentStatus']; rated: boolean },
  waiting: WaitingInfo | null,
): RideAction[] {
  const out: RideAction[] = [];
  switch (trip.status) {
    case 'SEARCHING':
      if (role === 'PASSENGER') out.push(cancelFor(role, trip.status));
      break;
    case 'DRIVER_EN_ROUTE':
      if (role === 'DRIVER') {
        out.push({ id: 'arrived', label: 'I have arrived at the pickup', tone: 'primary' });
      }
      out.push(cancelFor(role, trip.status));
      break;
    case 'DRIVER_ARRIVED':
      if (role === 'DRIVER') {
        out.push({ id: 'start', label: 'Start ride', tone: 'primary' });
        const waited = waiting?.driver?.seconds ?? 0;
        if (waiting && waited >= waiting.rule.noShowAfterSeconds) {
          out.push({
            id: 'noShow',
            label: 'Passenger did not arrive',
            tone: 'danger',
            confirm: {
              title: 'Cancel because the passenger did not arrive?',
              message: `You have waited ${formatElapsed(waited)}. The ride will be cancelled.`,
            },
          });
        }
      }
      out.push(cancelFor(role, trip.status));
      break;
    case 'IN_PROGRESS':
      if (role === 'DRIVER') {
        out.push({
          id: 'complete',
          label: 'End ride',
          tone: 'primary',
          confirm: {
            title: 'End this ride?',
            message: 'Only end the ride once you have reached the destination.',
          },
        });
      }
      break;
    case 'COMPLETED':
      if (role === 'DRIVER' && trip.paymentStatus === 'PENDING') {
        out.push({ id: 'confirmPayment', label: 'Confirm cash received', tone: 'primary' });
      }
      if (trip.paymentStatus === 'PAID' && !trip.rated) {
        out.push({
          id: 'rate',
          label: role === 'PASSENGER' ? 'Rate your driver' : 'Rate the passenger',
          tone: 'primary',
        });
      }
      out.push({ id: 'dispute', label: 'Report a problem with this ride', tone: 'neutral' });
      break;
    default:
  }
  return out;
}

/** One sentence about where the money stands, in words (never colour or an icon alone). */
export function paymentText(
  role: TripRole,
  status: TripSummary['paymentStatus'],
  amountNpr: number | null,
): string {
  const amount = amountNpr === null ? '' : ` ${formatNpr(amountNpr)}`;
  switch (status) {
    case 'PENDING':
      return role === 'PASSENGER'
        ? `Please pay your driver${amount} in cash.`
        : `Collect${amount} in cash from the passenger, then confirm.`;
    case 'PAID':
      return `Payment${amount} received. Paid in cash.`;
    case 'FAILED':
      return 'The payment did not go through.';
    case 'VOID':
      return 'No payment is due for this ride.';
    default:
      return '';
  }
}

/** Plain-language state of a ride that is not live (history rows, summaries). */
export function outcomeText(
  t: Pick<TripSummary, 'status' | 'cancelledBy' | 'cancelReason'>,
  role: TripRole,
): string {
  switch (t.status) {
    case 'COMPLETED':
      return 'Ride completed.';
    case 'NO_DRIVERS':
      return 'No driver was available.';
    case 'CANCELLED': {
      const who =
        t.cancelledBy === 'PASSENGER'
          ? role === 'PASSENGER'
            ? 'you'
            : 'the passenger'
          : t.cancelledBy === 'DRIVER'
            ? role === 'DRIVER'
              ? 'you'
              : 'the driver'
            : 'Yatri';
      return `Ride cancelled by ${who}.${t.cancelReason ? ` Reason: ${t.cancelReason}.` : ''}`;
    }
    default:
      return 'Ride in progress.';
  }
}
