import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { DisabilityVerificationView } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { cardLines, driverSharingLine, expiryLine, nextStepLine, submitHint } from './disabilityText';

const view = (over: Partial<DisabilityVerificationView> = {}): DisabilityVerificationView => ({
  enabled: true,
  status: 'NOT_SUBMITTED',
  statusLabel: 'Not submitted',
  statusText: 'Disability benefit verification has not been submitted. Status: Not submitted. You can apply whenever you wish. It is optional.',
  method: 'MANUAL',
  verifiedMethod: null,
  methods: [],
  consent: { policyKey: 'K', title: 'T', version: '1', contentUrl: null, given: true, givenAt: null },
  card: { last4: null, issuingAuthority: null, issueDate: null, expiryDate: null, hasDocument: false, documentName: null },
  message: null,
  submittedAt: null,
  verifiedAt: null,
  validUntil: null,
  expiry: { daysLeft: null, state: null },
  canOptIn: false,
  canEdit: true,
  canSubmit: false,
  gaps: ['Enter your card number.', 'Add a photo or PDF of your card.'],
  canWithdraw: true,
  driverSharing: false,
  benefit: { active: false, text: 'No disability benefit is active.' },
  history: [],
  ...over,
});

describe('the disability benefit words', () => {
  it('shows a card without its number, and says when nothing has been added', () => {
    expect(cardLines(view())).toEqual(['No document added yet.']);
    const lines = cardLines(view({ card: { last4: '4821', issuingAuthority: 'District Office', issueDate: '2022-01-01', expiryDate: '2030-01-01', hasDocument: true, documentName: 'card.png' } }));
    expect(lines.join(' ')).toContain('ending in 4 8 2 1');
    expect(lines).toContain('Issued by: District Office.');
    expect(lines.join(' ')).not.toMatch(/\d{5,}/); // never more than the last four
  });

  it('says in words what is missing and why a button cannot be used', () => {
    expect(submitHint(view())).toBe('Before you can send it: Enter your card number. Add a photo or PDF of your card.');
    expect(submitHint(view({ canSubmit: true, gaps: [] }))).toBeNull();
    expect(submitHint(view({ canEdit: false }))).toBeNull();
  });

  it('describes the expiry as a sentence, only for a verified card', () => {
    expect(expiryLine(view())).toBeNull();
    const v = view({ status: 'VERIFIED', validUntil: '2026-10-09', expiry: { daysLeft: 7, state: 'EXPIRING_SOON' } });
    expect(expiryLine(v)).toContain('runs out in 7 days');
    expect(expiryLine(v)).toContain('apply again');
    expect(expiryLine(view({ status: 'VERIFIED', validUntil: '2030-01-01', expiry: { daysLeft: 1, state: 'VALID' } }))).toContain('tomorrow');
  });

  it('is clear about what a driver can see', () => {
    expect(driverSharingLine(view({ driverSharing: false }))).toContain('cannot see');
    const on = driverSharingLine(view({ driverSharing: true }));
    expect(on).toContain('only that your benefit is verified');
    expect(on).toContain('never see your card number');
  });

  it('gives a next step for every state', () => {
    expect(nextStepLine(view({ status: 'NEEDS_CORRECTION' }))).toContain('fix');
    expect(nextStepLine(view({ status: 'EXPIRED' }))).toContain('apply again');
  });
});

describe('the disability benefit screen (static checks, not a replacement for TalkBack or VoiceOver)', () => {
  const src = readFileSync(path.resolve(__dirname, 'components', 'DisabilityBenefitCenter.tsx'), 'utf8');

  it('announces every status change and every problem, in words', () => {
    expect(src).toMatch(/<Announcer/);
    expect(src).toMatch(/say\(next\.statusText\)/);
    expect(src).toMatch(/accessibilityRole="alert"/);
  });

  it('labels every field and gives every group a heading (cards are headed sections)', () => {
    for (const m of src.matchAll(/<TextInput[\s\S]*?\/>/g)) expect(m[0]).toMatch(/accessibilityLabel=/);
    for (const title of ['Disability benefit', 'Consent', 'Your card', 'Who can see this', 'Stop and erase my details']) {
      expect(src).toContain(`title="${title}"`);
    }
  });

  it('never sets or guesses a status, and never keeps the card number on the phone', () => {
    expect(src).not.toMatch(/status:\s*'VERIFIED'|setStatus|'VERIFIED'/);
    expect(src).not.toMatch(/AsyncStorage|SecureStore|localStorage|MMKV/);
    expect(src).toMatch(/setNumber\(''\)/); // cleared once sent
  });

  it('asks twice before erasing, with the consequence in words', () => {
    expect(src).toMatch(/Are you sure\? This cannot be undone\./);
    expect(src).toMatch(/No, keep my application/);
  });

  it('says the whole thing is optional, and does not depend on motion', () => {
    expect(src).toMatch(/OPTIONAL_TEXT/);
    expect(src).not.toMatch(/Animated|LayoutAnimation/);
  });
});
