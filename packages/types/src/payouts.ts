/**
 * Online money, the other direction: refunds of online payments and payouts to drivers.
 *
 * Cash never touches Yatri: the passenger pays the driver. An online payment does: the provider settles to Yatri, so Yatri owes
 * the driver the fare. This file is the ONE definition of what a driver is owed for an online ride, how a payout moves through
 * its states, what a payout account is and how it is described. The API decides and records everything; the apps and the admin
 * screens show these shapes and send intentions.
 */

// ---------------------------------------------------------------- what a driver is owed

/**
 * What the driver is owed for ONE online-paid ride: the full fare (a promotion is paid by Yatri, never taken from the driver),
 * less the share of any refund on it that the platform setting makes the driver's. Whole rupees, never negative.
 */
export function driverPayableForRide(r: {
  fareNpr: number;
  refundedNpr: number;
  /** ONLINE_REFUND_DRIVER_SHARE_PERCENT: 0 means Yatri bears refunds, 100 means the driver does. */
  driverSharePercent: number;
}): number {
  const share = Math.floor((Math.max(0, r.refundedNpr) * Math.min(100, Math.max(0, r.driverSharePercent))) / 100);
  return Math.max(0, r.fareNpr - share);
}

// ---------------------------------------------------------------- payout states

export const PAYOUT_STATUSES = ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_STATUS_LABELS: Record<PayoutStatus, string> = {
  PENDING: 'Prepared, not yet sent',
  PROCESSING: 'Being sent',
  PAID: 'Paid',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/** Every legal move, once. PAID and CANCELLED are final; a failed payout can be tried again or cancelled. */
export const PAYOUT_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  PENDING: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PAID', 'FAILED'],
  PAID: [],
  FAILED: ['PROCESSING', 'CANCELLED'],
  CANCELLED: [],
};
export const canPayoutTransition = (from: PayoutStatus, to: PayoutStatus) =>
  PAYOUT_TRANSITIONS[from].includes(to);

/** A payout in these states still holds its rides (they cannot go in another payout). */
export const PAYOUT_HOLDING_STATES: readonly PayoutStatus[] = ['PENDING', 'PROCESSING', 'FAILED', 'PAID'];

// ---------------------------------------------------------------- payout accounts

export const PAYOUT_ACCOUNT_KINDS = ['BANK', 'KHALTI', 'ESEWA', 'IME_PAY'] as const;
export type PayoutAccountKind = (typeof PAYOUT_ACCOUNT_KINDS)[number];
export const PAYOUT_ACCOUNT_LABELS: Record<PayoutAccountKind, { label: string; numberLabel: string }> = {
  BANK: { label: 'Bank account', numberLabel: 'Account number' },
  KHALTI: { label: 'Khalti wallet', numberLabel: 'Khalti mobile number' },
  ESEWA: { label: 'eSewa wallet', numberLabel: 'eSewa mobile number' },
  IME_PAY: { label: 'IME Pay wallet', numberLabel: 'IME Pay mobile number' },
};

export const PAYOUT_HOLDER_MIN = 2;
export const PAYOUT_HOLDER_MAX = 80;
export const PAYOUT_NUMBER_MIN = 6;
export const PAYOUT_NUMBER_MAX = 30;

/** Digits and letters only: the form in which an account number is kept. */
export const normalizeAccountNumber = (raw: string): string => raw.replace(/[^0-9A-Za-z]/g, '');

/** What is wrong with a payout account, in words, or null. */
export function payoutAccountProblem(a: { kind: string; holderName: string; accountNumber: string }): string | null {
  if (!(PAYOUT_ACCOUNT_KINDS as readonly string[]).includes(a.kind)) return 'Choose where payouts should go.';
  const holder = a.holderName.trim();
  if (holder.length < PAYOUT_HOLDER_MIN || holder.length > PAYOUT_HOLDER_MAX) {
    return `The name on the account needs ${PAYOUT_HOLDER_MIN} to ${PAYOUT_HOLDER_MAX} characters.`;
  }
  const n = normalizeAccountNumber(a.accountNumber);
  if (n.length < PAYOUT_NUMBER_MIN || n.length > PAYOUT_NUMBER_MAX) {
    return `The ${PAYOUT_ACCOUNT_LABELS[a.kind as PayoutAccountKind].numberLabel.toLowerCase()} needs ${PAYOUT_NUMBER_MIN} to ${PAYOUT_NUMBER_MAX} letters or digits.`;
  }
  if (a.kind !== 'BANK' && !/^\d+$/.test(n)) return 'A wallet is identified by a mobile number: digits only.';
  return null;
}

/** "ending in 4 8 2 1": what the driver sees of their own number, readable by a screen reader. */
export const maskedAccount = (last4: string | null): string =>
  last4 ? `ending in ${last4.split('').join(' ')}` : 'no account saved';

// ---------------------------------------------------------------- the driver's view

export interface PayoutInfo {
  id: string;
  amountNpr: number;
  rides: number;
  status: PayoutStatus;
  statusText: string;
  createdAt: string;
  paidAt: string | null;
  /** The reference the payer gave (a bank or wallet transaction id), once paid. */
  reference: string | null;
}

export interface DriverPayoutSummary {
  /** Owed and ready to be paid out now (past the hold, no refund under way). */
  readyNpr: number;
  /** Owed, but still inside the hold or with a refund being decided. */
  holdingNpr: number;
  /** In a payout that is prepared or being sent. */
  inPayoutNpr: number;
  paidNpr: number;
  minPayoutNpr: number;
  holdHours: number;
  account: { kind: PayoutAccountKind; holderName: string; last4: string } | null;
  /** The sentences the driver reads (and a screen reader speaks), from the same numbers. */
  sentences: string[];
  payouts: PayoutInfo[];
}

export interface PayoutAccountBody {
  kind: PayoutAccountKind;
  holderName: string;
  accountNumber: string;
}

export function driverPayoutSentences(s: Omit<DriverPayoutSummary, 'sentences' | 'payouts'>): string[] {
  const out: string[] = [];
  out.push(
    s.readyNpr > 0
      ? `NPR ${s.readyNpr} from online rides is ready to be paid out.`
      : 'Nothing from online rides is ready to be paid out yet.',
  );
  if (s.holdingNpr > 0) {
    out.push(`NPR ${s.holdingNpr} is on hold for ${s.holdHours} hours after each ride, in case of a problem, or while a refund is decided.`);
  }
  if (s.inPayoutNpr > 0) out.push(`NPR ${s.inPayoutNpr} is in a payout that is being prepared or sent.`);
  if (s.paidNpr > 0) out.push(`NPR ${s.paidNpr} has been paid out to you.`);
  out.push(`Payouts are made when at least NPR ${s.minPayoutNpr} is ready. Cash rides are never part of a payout: you keep that cash.`);
  out.push(
    s.account
      ? `Payouts go to your ${PAYOUT_ACCOUNT_LABELS[s.account.kind].label.toLowerCase()} (${maskedAccount(s.account.last4)}).`
      : 'Add where payouts should go. Without it, no payout can be sent.',
  );
  return out;
}

// ---------------------------------------------------------------- the staff view

export interface AdminPayoutRow {
  id: string;
  driverId: string;
  driverName: string | null;
  amountNpr: number;
  rides: number;
  status: PayoutStatus;
  statusLabel: string;
  accountKind: PayoutAccountKind;
  createdAt: string;
  paidAt: string | null;
}

export interface AdminPayoutDetail extends AdminPayoutRow {
  accountHolder: string;
  /** Only the last four characters here; the full number is a separate, audited call for staff who manage payouts. */
  accountLast4: string;
  reference: string | null;
  failedReason: string | null;
  createdByName: string | null;
  decidedByName: string | null;
  allowedNext: PayoutStatus[];
  items: Array<{ tripId: string; amountNpr: number }>;
}

/** The account to pay, in full. Opening it needs PAYOUTS_MANAGE and is audited. */
export interface AdminPayoutAccountReveal {
  kind: PayoutAccountKind;
  kindLabel: string;
  holder: string;
  number: string;
}

export interface AdminPayoutList {
  items: AdminPayoutRow[];
  total: number;
  readyDrivers: number;
  readyNpr: number;
  limit: number;
  offset: number;
}

export interface AdminPayoutActionBody {
  to: PayoutStatus;
  reference?: string;
  failedReason?: string;
  note?: string;
}

export const PAYOUT_NOTIFICATION_TYPES = {
  PAYMENT_PAYOUT_SENT: 'PAYMENT_PAYOUT_SENT',
  PAYMENT_PAYOUT_FAILED: 'PAYMENT_PAYOUT_FAILED',
} as const;
