import type {
  OrgApprovalInfo,
  OrgBookingPreview,
  OrgMemberInfo,
  OrgPermission,
  OrgStatementInfo,
} from '@yatri/types';
import { ORG_ROLE_PERMISSIONS, describeOrgPolicy, DEFAULT_ORG_POLICY } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import {
  approvalLine,
  bookingNews,
  checkOrganizationName,
  memberLine,
  parseLimit,
  previewText,
  sectionsFor,
  statementLine,
} from './businessText';

const ids = (p: readonly OrgPermission[]) => sectionsFor(p).map((s) => s.id);

describe('which sections a role sees (from the permissions the server listed)', () => {
  it('shows each role only what it can use', () => {
    expect(ids(ORG_ROLE_PERMISSIONS.OWNER)).toEqual([
      'rides',
      'approvals',
      'members',
      'policy',
      'statements',
      'usage',
    ]);
    expect(ids(ORG_ROLE_PERMISSIONS.MEMBER)).toEqual(['rides', 'approvals', 'policy']);
    expect(ids(ORG_ROLE_PERMISSIONS.BOOKER)).toEqual(['rides', 'approvals', 'members', 'policy']);
    expect(ids(ORG_ROLE_PERMISSIONS.VIEWER)).toEqual([
      'rides',
      'approvals',
      'members',
      'policy',
      'usage',
    ]);
  });

  it('words the first two sections for what the person may see', () => {
    expect(
      sectionsFor(ORG_ROLE_PERMISSIONS.OWNER)
        .slice(0, 2)
        .map((s) => s.label),
    ).toEqual(['All rides', 'Approvals']);
    expect(
      sectionsFor(ORG_ROLE_PERMISSIONS.MEMBER)
        .slice(0, 2)
        .map((s) => s.label),
    ).toEqual(['My rides', 'My requests']);
  });
});

describe('checking what was typed', () => {
  it('accepts whole rupees or nothing for a limit', () => {
    expect(parseLimit('')).toEqual({ ok: true, value: null });
    expect(parseLimit(' 5000 ')).toEqual({ ok: true, value: 5000 });
    for (const bad of ['0', '-5', '12.5', 'abc', '99999999999'])
      expect(parseLimit(bad).ok).toBe(false);
  });
  it('asks for a name and a sensible email', () => {
    expect(checkOrganizationName('A', '')).toMatch(/name/);
    expect(checkOrganizationName('Acme', 'nope')).toMatch(/email/);
    expect(checkOrganizationName('Acme', 'a@b.co')).toBeNull();
    expect(checkOrganizationName('Acme', '')).toBeNull();
  });
});

describe('sentences from what the server answered', () => {
  const approval: OrgApprovalInfo = {
    id: 'a',
    status: 'PENDING',
    requestedByName: 'Bina',
    passengerName: 'Mina',
    pickupAddress: 'Thamel',
    destinationAddress: 'Patan',
    vehicleCategory: 'CAR',
    fareNpr: 640,
    costCenterName: null,
    purpose: 'Client visit',
    reasons: [],
    expiresAt: '',
    createdAt: '',
    decidedByName: null,
    decidedAt: null,
    decisionNote: null,
    tripId: null,
    canDecide: true,
    canCancel: false,
  };
  it('describes an approval with who, why, where and how much, in words', () => {
    expect(approvalLine(approval)).toBe(
      'Bina asked for a ride for Mina, for Client visit: Thamel to Patan, about NPR 640. Waiting for approval.',
    );
    expect(approvalLine({ ...approval, requestedByName: 'Mina', purpose: null })).toMatch(
      /^Mina asked for a ride:/,
    );
  });
  it('describes members and statements without colour or icons', () => {
    const m: OrgMemberInfo = {
      id: 'm',
      userId: 'u',
      name: 'Vik',
      role: 'VIEWER',
      status: 'INVITED',
      defaultCostCenterId: null,
      canChange: false,
      invitedAt: '',
      joinedAt: null,
    };
    expect(memberLine(m)).toBe('Vik, viewer, invited, not yet accepted');
    const s: OrgStatementInfo = {
      id: 's',
      number: 12,
      periodKey: '2026-09',
      status: 'ISSUED',
      rides: 1,
      totalNpr: 500,
      issuedAt: '',
      dueOn: '2026-10-16',
      paidAt: null,
      paidReference: null,
    };
    expect(statementLine(s)).toBe(
      'Statement 12, 2026-09: 1 ride, NPR 500. Issued, awaiting payment, due 2026-10-16.',
    );
    expect(statementLine({ ...s, status: 'PAID', rides: 3 })).toBe(
      'Statement 12, 2026-09: 3 rides, NPR 500. Paid.',
    );
  });
  it('says what the policy decided before and after booking', () => {
    const p: OrgBookingPreview = {
      outcome: 'NEEDS_APPROVAL',
      reasons: ['Rides over NPR 500 need approval.'],
      fareNpr: 640,
    };
    expect(previewText(p)).toBe(
      'The fare is about NPR 640. Rides over NPR 500 need approval. It will wait for approval before a driver is sent.',
    );
    expect(previewText({ outcome: 'DENIED', reasons: ['Too dear.'], fareNpr: 1 })).toBe(
      'Too dear. This ride cannot be booked.',
    );
    expect(previewText({ outcome: 'ALLOWED', reasons: [], fareNpr: 300 })).toBe(
      'The fare is about NPR 300. This ride is allowed.',
    );
    expect(
      bookingNews(
        { outcome: 'REQUESTED', tripId: 't', approval: null, reasons: [] },
        'Mina',
        false,
      ),
    ).toMatch(/for Mina.*their app/);
    expect(
      bookingNews({ outcome: 'REQUESTED', tripId: 't', approval: null, reasons: [] }, null, true),
    ).toBe('Your ride was requested.');
    expect(
      bookingNews(
        { outcome: 'NEEDS_APPROVAL', tripId: null, approval, reasons: ['Why.'] },
        null,
        true,
      ),
    ).toMatch(/Sent for approval. Why./);
  });
  it('reads the policy in the same words everywhere', () => {
    const lines = describeOrgPolicy({
      ...DEFAULT_ORG_POLICY,
      monthlyLimitNpr: 100000,
      approvalOverNpr: 2000,
    });
    expect(lines).toContain('Limit for the organization each month: NPR 100000.');
    expect(lines).toContain('Approval: rides over NPR 2000 need it.');
    expect(lines).toContain('Vehicle types: all.');
  });
});
