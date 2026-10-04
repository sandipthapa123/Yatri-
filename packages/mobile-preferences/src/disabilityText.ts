import {
  DISABILITY_PASSENGER_WORDS,
  maskedCard,
  type DisabilityVerificationView,
} from '@yatri/types';

/**
 * The words of the disability benefit screen. The status sentences, who may do what and what is missing all come from the
 * server's view (and from @yatri/types for the wording); these helpers only join them into plain sentences a screen reader
 * can read in order. Nothing here decides a status or an eligibility.
 */

export const OPTIONAL_TEXT =
  'Disability benefits are optional. Nothing is shared with anyone until you say so, and you can stop at any time. Withdrawing erases your card details and document.';

export const CONSENT_SENTENCE = (title: string) => `I agree: ${title}.`;

/** The one sentence announced when the status changes. */
export const statusAnnouncement = (v: DisabilityVerificationView) => v.statusText;

export function cardLines(v: DisabilityVerificationView): string[] {
  const out: string[] = [];
  if (v.card.last4) out.push(`Card number: ${maskedCard(v.card.last4)}.`);
  if (v.card.issuingAuthority) out.push(`Issued by: ${v.card.issuingAuthority}.`);
  if (v.card.issueDate) out.push(`Issue date: ${v.card.issueDate}.`);
  if (v.card.expiryDate) out.push(`Expiry date: ${v.card.expiryDate}.`);
  out.push(
    v.card.hasDocument
      ? `Document added: ${v.card.documentName ?? 'card document'}.`
      : 'No document added yet.',
  );
  return out;
}

export function expiryLine(v: DisabilityVerificationView): string | null {
  if (v.status !== 'VERIFIED' || v.expiry.daysLeft === null || !v.validUntil) return null;
  const d = v.expiry.daysLeft;
  const when = d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
  return `Your verification is valid until ${v.validUntil}. It runs out ${when}${v.expiry.state === 'EXPIRING_SOON' ? ', so please apply again with a valid card soon' : ''}.`;
}

export const nextStepLine = (v: DisabilityVerificationView): string =>
  DISABILITY_PASSENGER_WORDS[v.status].next;

export function driverSharingLine(v: DisabilityVerificationView): string {
  return v.driverSharing
    ? 'The driver of an accepted ride can see only that your benefit is verified. They never see your card number, your document or any other detail. You can change this in Settings, under Privacy.'
    : 'Your driver cannot see that you have a disability benefit. You can allow the driver of an accepted ride to see only that it is verified, in Settings, under Privacy.';
}

/** Why a button is unavailable, or null. Always tells the rider what to do instead of silently disabling it. */
export function submitHint(v: DisabilityVerificationView): string | null {
  if (v.canSubmit) return null;
  if (!v.canEdit) return null;
  return v.gaps.length > 0 ? `Before you can send it: ${v.gaps.join(' ')}` : null;
}
