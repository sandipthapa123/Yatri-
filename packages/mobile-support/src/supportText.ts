import {
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_SUBJECT_MAX,
  type RefundQuote,
  type RefundReason,
  type SupportCategory,
  type TicketInfo,
} from '@yatri/types';

/**
 * The wording and checks the support screens need that are not already words in @yatri/types. The status
 * sentences themselves (describeTicketStatus, describeRefundStatus, describeDataRequest) live there and
 * are the same ones the server sends in notifications; nothing here restates them.
 */

export interface NewTicketFields {
  categoryCode: string | null;
  subject: string;
  body: string;
  tripId?: string | null;
}
export type FieldErrors = Partial<Record<'category' | 'subject' | 'body' | 'ride', string>>;

/** What to fix before sending; the server checks the same rules again. Empty means it can be sent. */
export function checkNewTicket(f: NewTicketFields, category: SupportCategory | null): FieldErrors {
  const errors: FieldErrors = {};
  if (!f.categoryCode || !category) errors.category = 'Choose what this is about.';
  else if (category.requiresRide && !f.tripId) errors.ride = 'Choose the ride this is about.';
  if (f.subject.trim().length < 3) errors.subject = 'Write a short title of at least 3 characters.';
  else if (f.subject.trim().length > TICKET_SUBJECT_MAX) {
    errors.subject = `Keep the title under ${TICKET_SUBJECT_MAX} characters.`;
  }
  if (f.body.trim().length < TICKET_BODY_MIN) {
    errors.body = `Describe the problem in at least ${TICKET_BODY_MIN} characters.`;
  } else if (f.body.trim().length > TICKET_BODY_MAX) {
    errors.body = `Keep this under ${TICKET_BODY_MAX} characters.`;
  }
  return errors;
}

/** The categories to offer: a ride problem offers ride categories; otherwise the ones that need no ride. */
export function offeredCategories(
  all: SupportCategory[],
  tripId: string | null,
): SupportCategory[] {
  return all.filter((c) => (tripId ? c.requiresRide : !c.requiresRide));
}

/** One sentence when a ticket the person already knew about has changed status (read out politely). */
export function statusNews(before: TicketInfo[], after: TicketInfo[]): string | null {
  const known = new Map(before.map((t) => [t.id, t.status]));
  const changed = after.filter((t) => known.has(t.id) && known.get(t.id) !== t.status);
  if (changed.length === 0) return null;
  const first = changed[0] as TicketInfo;
  return changed.length === 1
    ? first.statusText
    : `${changed.length} of your requests have changed. ${first.statusText}`;
}

/** What each refund reason means, with the amount the server says it would come to. */
export function refundReasonLabel(reason: RefundReason, quote: RefundQuote | null): string {
  const amount = quote?.amounts[reason];
  switch (reason) {
    case 'FULL_FARE':
      return amount ? `The whole fare (NPR ${amount})` : 'The whole fare';
    case 'WAITING_CHARGE':
      return amount ? `The waiting charge (NPR ${amount})` : 'The waiting charge';
    case 'PARTIAL':
      return 'Part of the fare (you choose the amount)';
  }
}

/** The reasons that apply right now (a reason with no amount is not offered). */
export function availableRefundReasons(quote: RefundQuote): RefundReason[] {
  return (['FULL_FARE', 'WAITING_CHARGE', 'PARTIAL'] as const).filter(
    (r) => quote.amounts[r] !== null,
  );
}

export function checkPartialAmount(raw: string, quote: RefundQuote): string | null {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n < 1)
    return 'Enter the amount in whole rupees, for example 50.';
  if (n > quote.remainingNpr) return `The most you can ask for is NPR ${quote.remainingNpr}.`;
  return null;
}

/** "3 Oct 2026, 14:05": a date and time for a message, in the phone's own locale. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function fileSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
