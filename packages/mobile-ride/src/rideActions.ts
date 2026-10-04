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
  | 'cancel'
  | 'arrived'
  | 'start'
  | 'complete'
  | 'noShow'
  | 'confirmPayment'
  | 'payOnline'
  | 'checkOnlinePayment'
  | 'rate'
  | 'dispute'
  | 'incident';

export interface RideAction {
  id: RideActionId;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
  /** Ask before doing it (irreversible or affects the other person). */
  confirm?: { title: string; message: string };
}

const cancelFor = (role: TripRole, status: TripStatus, feeNpr: number): RideAction => {
  if (role === 'PASSENGER') {
    const fee = feeNpr > 0 ? ` A cancellation fee of ${formatNpr(feeNpr)} applies.` : '';
    return {
      id: 'cancel',
      label: status === 'SEARCHING' ? 'Cancel request' : 'Cancel ride',
      tone: 'danger',
      confirm: {
        title: status === 'SEARCHING' ? 'Cancel this request?' : 'Cancel this ride?',
        message:
          (status === 'SEARCHING'
            ? 'We will stop looking for a driver.'
            : 'Your driver will be told the ride was cancelled.') + fee,
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

const INCIDENT_ACTION: RideAction = {
  id: 'incident',
  label: 'Report a safety concern',
  tone: 'neutral',
};

export function rideActions(
  role: TripRole,
  trip: {
    status: TripStatus;
    paymentStatus: TripSummary['paymentStatus'];
    onlinePaymentAvailable?: boolean;
    rated: boolean;
    /** What cancelling costs now, as the server's cancellation rules say (0 = free). */
    cancelFeeNpr?: number;
    /** A ride billed to an organization has no cash for the driver to collect. */
    billedToOrganization?: boolean;
  },
  waiting: WaitingInfo | null,
): RideAction[] {
  const out: RideAction[] = [];
  const fee = trip.cancelFeeNpr ?? 0;
  switch (trip.status) {
    case 'SEARCHING':
      if (role === 'PASSENGER') out.push(cancelFor(role, trip.status, fee));
      break;
    case 'DRIVER_EN_ROUTE':
      if (role === 'DRIVER') {
        out.push({ id: 'arrived', label: 'I have arrived at the pickup', tone: 'primary' });
      }
      out.push(cancelFor(role, trip.status, fee), INCIDENT_ACTION);
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
      out.push(cancelFor(role, trip.status, fee), INCIDENT_ACTION);
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
      out.push(INCIDENT_ACTION);
      break;
    case 'COMPLETED':
      if (role === 'DRIVER' && trip.paymentStatus === 'PENDING' && !trip.billedToOrganization) {
        out.push({ id: 'confirmPayment', label: 'Confirm cash received', tone: 'primary' });
      }
      if (role === 'PASSENGER' && trip.onlinePaymentAvailable) {
        out.push({ id: 'payOnline', label: 'Pay online', tone: 'primary' });
        out.push({
          id: 'checkOnlinePayment',
          label: 'I have paid: check my payment',
          tone: 'neutral',
        });
      }
      // Ratings open when the ride is completed; how it was paid is a separate matter.
      if (!trip.rated) {
        out.push({
          id: 'rate',
          label: role === 'PASSENGER' ? 'Rate your driver' : 'Rate the passenger',
          tone: 'primary',
        });
      }
      out.push({ id: 'dispute', label: 'Report a problem with this ride', tone: 'neutral' });
      out.push(INCIDENT_ACTION);
      break;
    default:
  }
  return out;
}

/** One sentence saying a ride is a business ride, who it is for and who pays, for the rider and the driver. */
export function businessText(role: TripRole, b: NonNullable<TripSummary['business']>): string {
  const purpose = b.purpose ? ` Purpose: ${b.purpose}.` : '';
  if (role === 'PASSENGER') {
    return `Business ride for ${b.organizationName}${b.bookedByOther ? ', booked for you by someone there' : ''}.${purpose}`;
  }
  return `Business ride for ${b.organizationName}.${purpose}${b.billedToOrganization ? ' No cash to collect.' : ''}`;
}

/** One sentence about where the money stands, in words (never colour or an icon alone). */
export function paymentText(
  role: TripRole,
  status: TripSummary['paymentStatus'],
  amountNpr: number | null,
  /** Set for a business ride the organization pays for (the words differ: nobody pays the driver). */
  business: TripSummary['business'] = null,
  /** How it was paid, when known (the words differ for an online payment). */
  method: 'CASH' | 'ORGANIZATION' | 'DIGITAL' | null = null,
  /** True when the rider can pay online (the server decides). */
  online = false,
): string {
  const amount = amountNpr === null ? '' : ` ${formatNpr(amountNpr)}`;
  if (business?.billedToOrganization && (status === 'PENDING' || status === 'PAID')) {
    return role === 'PASSENGER'
      ? `Nothing to pay: ${business.organizationName} pays for this ride${amount ? ` (${amount.trim()})` : ''}.`
      : `Nothing to collect: ${business.organizationName} is billed${amount ? ` ${amount.trim()}` : ''} for this ride.`;
  }
  switch (status) {
    case 'PENDING':
      return role === 'PASSENGER'
        ? online
          ? `Please pay${amount}: online here, or in cash to your driver.`
          : `Please pay your driver${amount} in cash.`
        : `Collect${amount} in cash from the passenger, then confirm.`;
    case 'PAID':
      return method === 'DIGITAL'
        ? `Payment${amount} received. Paid online.`
        : `Payment${amount} received. Paid in cash.`;
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
