import {
  ORG_APPROVAL_STATUS_LABELS,
  ORG_LIMIT_MAX_NPR,
  ORG_MEMBER_STATUS_LABELS,
  ORG_ROLE_LABELS,
  ORG_STATEMENT_STATUS_LABELS,
  formatNpr,
  orgRoleHolds,
  type OrgApprovalInfo,
  type OrgBookingPreview,
  type OrgBookingResult,
  type OrgMemberInfo,
  type OrgPermission,
  type OrgStatementInfo,
} from '@yatri/types';

/**
 * Wording and validation for the business screens, with no framework in it so it can be tested. The server
 * decides every outcome and every amount; these only turn what it answered into sentences, and check what a
 * person typed before it is sent (the server checks again).
 */

/** The sections a person sees, from the permissions the SERVER listed for their role (never worked out here). */
export type SectionId = 'rides' | 'approvals' | 'members' | 'policy' | 'statements' | 'usage';

export function sectionsFor(
  permissions: readonly OrgPermission[],
): Array<{ id: SectionId; label: string }> {
  const has = (p: OrgPermission) => permissions.includes(p);
  const out: Array<{ id: SectionId; label: string }> = [
    { id: 'rides', label: has('RIDES_VIEW_ALL') ? 'All rides' : 'My rides' },
    { id: 'approvals', label: has('RIDES_APPROVE') ? 'Approvals' : 'My requests' },
  ];
  if (has('MEMBERS_MANAGE') || has('RIDES_BOOK_FOR_OTHERS') || has('RIDES_VIEW_ALL')) {
    out.push({ id: 'members', label: 'Members' });
  }
  out.push({ id: 'policy', label: 'Rules and cost centres' });
  if (has('BILLING_VIEW')) out.push({ id: 'statements', label: 'Statements' });
  if (has('REPORTS_VIEW')) out.push({ id: 'usage', label: 'Usage' });
  return out;
}

/** A limit typed in whole rupees; empty means "no limit". */
export function parseLimit(
  text: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d+$/.test(t))
    return {
      ok: false,
      message: 'Use whole rupees, for example 5000, or leave it empty for no limit.',
    };
  const n = Number(t);
  if (n < 1 || n > ORG_LIMIT_MAX_NPR) {
    return {
      ok: false,
      message: `Use a number from 1 to ${ORG_LIMIT_MAX_NPR}, or leave it empty.`,
    };
  }
  return { ok: true, value: n };
}

export function checkOrganizationName(name: string, email: string): string | null {
  if (name.trim().length < 2) return 'Give the organization a name of at least two letters.';
  if (email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return 'That email address does not look right.';
  }
  return null;
}

export const roleLabel = (r: Parameters<typeof orgRoleHolds>[0]) => ORG_ROLE_LABELS[r];

export function memberLine(m: OrgMemberInfo): string {
  const status =
    m.status === 'ACTIVE' ? '' : `, ${ORG_MEMBER_STATUS_LABELS[m.status].toLowerCase()}`;
  return `${m.name ?? 'Unnamed person'}, ${ORG_ROLE_LABELS[m.role].toLowerCase()}${status}`;
}

export function approvalLine(a: OrgApprovalInfo): string {
  const who =
    a.requestedByName && a.requestedByName !== a.passengerName
      ? `${a.requestedByName} asked for a ride for ${a.passengerName ?? 'a member'}`
      : `${a.passengerName ?? 'A member'} asked for a ride`;
  const why = a.purpose ? `, for ${a.purpose}` : '';
  return `${who}${why}: ${a.pickupAddress} to ${a.destinationAddress}, about ${formatNpr(a.fareNpr)}. ${ORG_APPROVAL_STATUS_LABELS[a.status]}.`;
}

export function statementLine(s: OrgStatementInfo): string {
  return `Statement ${s.number}, ${s.periodKey}: ${s.rides} ride${s.rides === 1 ? '' : 's'}, ${formatNpr(s.totalNpr)}. ${ORG_STATEMENT_STATUS_LABELS[s.status]}${s.status === 'ISSUED' ? `, due ${s.dueOn}` : ''}.`;
}

/** What a rider is told before booking, from the server's policy decision. */
export function previewText(p: OrgBookingPreview): string {
  const fare = `The fare is about ${formatNpr(p.fareNpr)}.`;
  if (p.outcome === 'ALLOWED') return `${fare} This ride is allowed.`;
  if (p.outcome === 'NEEDS_APPROVAL')
    return `${fare} ${p.reasons.join(' ')} It will wait for approval before a driver is sent.`;
  return `${p.reasons.join(' ')} This ride cannot be booked.`;
}

/** What to say after booking. A ride booked for someone else is followed from THEIR app, so the booker is told that. */
export function bookingNews(
  r: OrgBookingResult,
  riderName: string | null,
  forSelf: boolean,
): string {
  if (r.outcome === 'NEEDS_APPROVAL') {
    return `Sent for approval. ${r.reasons.join(' ')} No driver is sent until it is approved, and you will be told.`;
  }
  return forSelf
    ? 'Your ride was requested.'
    : `The ride was requested for ${riderName ?? 'the rider'}. They were told and can follow it in their app.`;
}
