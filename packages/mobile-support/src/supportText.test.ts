import type { RefundQuote, SupportCategory, TicketInfo } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import {
  availableRefundReasons,
  checkNewTicket,
  checkPartialAmount,
  fileSizeText,
  offeredCategories,
  refundReasonLabel,
  statusNews,
} from './supportText';

const cat = (over: Partial<SupportCategory>): SupportCategory => ({
  code: 'C',
  label: 'L',
  help: 'h',
  kind: 'GENERAL',
  forRoles: ['PASSENGER'],
  requiresRide: false,
  defaultPriority: 'NORMAL',
  isActive: true,
  sortOrder: 1,
  ...over,
});
const ticket = (id: string, status: TicketInfo['status'], statusText: string): TicketInfo => ({
  id,
  number: 1,
  categoryCode: 'C',
  categoryLabel: 'L',
  isDispute: false,
  subject: 's',
  status,
  statusText,
  tripId: null,
  createdAt: '',
  updatedAt: '',
  resolvedAt: null,
  outcome: null,
  resolution: null,
});
const quote: RefundQuote = {
  paidNpr: 300,
  refundedNpr: 100,
  remainingNpr: 200,
  waitingChargeNpr: 0,
  amounts: { FULL_FARE: null, WAITING_CHARGE: null, PARTIAL: 200 },
};

describe('new request checks', () => {
  it('names each thing to fix, and accepts a complete request', () => {
    expect(checkNewTicket({ categoryCode: null, subject: '', body: '' }, null)).toMatchObject({
      category: expect.any(String),
      subject: expect.any(String),
      body: expect.any(String),
    });
    const ride = cat({ requiresRide: true });
    expect(
      checkNewTicket(
        { categoryCode: 'C', subject: 'Fare', body: 'The fare was wrong today' },
        ride,
      ),
    ).toEqual({ ride: 'Choose the ride this is about.' });
    expect(
      checkNewTicket(
        { categoryCode: 'C', subject: 'Fare', body: 'The fare was wrong today', tripId: 't' },
        ride,
      ),
    ).toEqual({});
    expect(
      checkNewTicket({ categoryCode: 'C', subject: 'Hi', body: 'x'.repeat(5000) }, cat({})).body,
    ).toContain('under');
  });

  it('offers ride categories for a ride problem and the others otherwise', () => {
    const all = [cat({ code: 'A' }), cat({ code: 'B', requiresRide: true, kind: 'DISPUTE' })];
    expect(offeredCategories(all, 'trip').map((c) => c.code)).toEqual(['B']);
    expect(offeredCategories(all, null).map((c) => c.code)).toEqual(['A']);
  });
});

describe('status news', () => {
  it('reports only tickets that were known and changed', () => {
    const before = [ticket('a', 'OPEN', 'received'), ticket('b', 'OPEN', 'received')];
    expect(statusNews(before, before)).toBeNull();
    const after = [
      ticket('a', 'RESOLVED', 'a is resolved'),
      ticket('b', 'OPEN', 'received'),
      ticket('c', 'OPEN', 'new'),
    ];
    expect(statusNews(before, after)).toBe('a is resolved');
    const two = [ticket('a', 'RESOLVED', 'a is resolved'), ticket('b', 'CLOSED', 'b is closed')];
    expect(statusNews(before, two)).toBe('2 of your requests have changed. a is resolved');
  });
});

describe('refund wording', () => {
  it('only offers reasons that have an amount, and checks a partial amount', () => {
    expect(availableRefundReasons(quote)).toEqual(['PARTIAL']);
    expect(refundReasonLabel('PARTIAL', quote)).toContain('you choose');
    expect(
      refundReasonLabel('FULL_FARE', { ...quote, amounts: { ...quote.amounts, FULL_FARE: 300 } }),
    ).toContain('NPR 300');
    expect(checkPartialAmount('50', quote)).toBeNull();
    expect(checkPartialAmount('200', quote)).toBeNull();
    expect(checkPartialAmount('201', quote)).toContain('NPR 200');
    for (const bad of ['', '0', '-3', '1.5', 'abc'])
      expect(checkPartialAmount(bad, quote)).not.toBeNull();
  });
  it('writes file sizes plainly', () => {
    expect(fileSizeText(500)).toBe('500 bytes');
    expect(fileSizeText(2048)).toBe('2 KB');
    expect(fileSizeText(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
