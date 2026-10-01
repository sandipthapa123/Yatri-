import type { WaitingInfo } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { businessText, outcomeText, paymentText, rideActions } from './rideActions';

const waiting = (driverSeconds: number): WaitingInfo => ({
  driver: { startedAt: '', seconds: driverSeconds, notifiedAt: null },
  passenger: null,
  rule: { freeSeconds: 180, perMinuteNpr: 5, noShowAfterSeconds: 600 },
  affectsFare: driverSeconds > 180,
  chargeableSeconds: 0,
  chargeNpr: 0,
});
const trip = (
  status: Parameters<typeof rideActions>[1]['status'],
  paymentStatus: 'NONE' | 'PENDING' | 'PAID' = 'NONE',
  rated = false,
) => ({ status, paymentStatus, rated });
const ids = (a: ReturnType<typeof rideActions>) => a.map((x) => x.id);

describe('rideActions: who sees which button', () => {
  it('passenger: can cancel while searching, en route and after arrival — nothing else mid-ride', () => {
    expect(ids(rideActions('PASSENGER', trip('SEARCHING'), null))).toEqual(['cancel']);
    expect(ids(rideActions('PASSENGER', trip('DRIVER_EN_ROUTE'), null))).toEqual([
      'cancel',
      'incident',
    ]);
    expect(ids(rideActions('PASSENGER', trip('DRIVER_ARRIVED'), waiting(30)))).toEqual([
      'cancel',
      'incident',
    ]);
    expect(ids(rideActions('PASSENGER', trip('IN_PROGRESS'), null))).toEqual(['incident']);
  });

  it('driver: arrived, then start, then end — in that order', () => {
    expect(ids(rideActions('DRIVER', trip('SEARCHING'), null))).toEqual([]);
    expect(ids(rideActions('DRIVER', trip('DRIVER_EN_ROUTE'), null))).toEqual([
      'arrived',
      'cancel',
      'incident',
    ]);
    expect(ids(rideActions('DRIVER', trip('DRIVER_ARRIVED'), waiting(30)))).toEqual([
      'start',
      'cancel',
      'incident',
    ]);
    expect(ids(rideActions('DRIVER', trip('IN_PROGRESS'), null))).toEqual(['complete', 'incident']);
  });

  it('offers "passenger did not arrive" only once the server no-show wait has passed', () => {
    expect(ids(rideActions('DRIVER', trip('DRIVER_ARRIVED'), waiting(599)))).not.toContain(
      'noShow',
    );
    const late = rideActions('DRIVER', trip('DRIVER_ARRIVED'), waiting(601));
    expect(ids(late)).toContain('noShow');
    expect(late.find((a) => a.id === 'noShow')?.confirm?.message).toContain('10 minutes 1 second');
  });

  it('asks before anything destructive, and words cancel differently for each side', () => {
    const p = rideActions('PASSENGER', trip('SEARCHING'), null)[0]!;
    expect(p).toMatchObject({ label: 'Cancel request', tone: 'danger' });
    expect(p.confirm).toBeDefined();
    const d = rideActions('DRIVER', trip('DRIVER_EN_ROUTE'), null).find((a) => a.id === 'cancel')!;
    expect(d.label).toBe('Cannot do this ride');
    expect(d.confirm?.message).toContain('another driver');
    expect(rideActions('DRIVER', trip('IN_PROGRESS'), null)[0]!.confirm).toBeDefined();
  });

  it('after the ride: rating opens at once (payment is separate), once each, and either can report a problem', () => {
    // the driver still has cash to confirm; nobody has to wait for that to rate
    expect(ids(rideActions('DRIVER', trip('COMPLETED', 'PENDING'), null))).toEqual([
      'confirmPayment',
      'rate',
      'dispute',
      'incident',
    ]);
    expect(ids(rideActions('PASSENGER', trip('COMPLETED', 'PENDING'), null))).toEqual([
      'rate',
      'dispute',
      'incident',
    ]);
    expect(ids(rideActions('PASSENGER', trip('COMPLETED', 'PAID'), null))).toEqual([
      'rate',
      'dispute',
      'incident',
    ]);
    expect(ids(rideActions('PASSENGER', trip('COMPLETED', 'PAID', true), null))).toEqual([
      'dispute',
      'incident',
    ]); // already rated
    expect(ids(rideActions('DRIVER', trip('COMPLETED', 'PAID'), null))).toEqual([
      'rate',
      'dispute',
      'incident',
    ]);
  });

  it('states the cancellation fee the server reports, and only when there is one', () => {
    const late = { ...trip('DRIVER_EN_ROUTE'), cancelFeeNpr: 50 };
    const cancel = rideActions('PASSENGER', late, null).find((a) => a.id === 'cancel')!;
    expect(cancel.confirm?.message).toBe(
      'Your driver will be told the ride was cancelled. A cancellation fee of NPR 50 applies.',
    );
    const free = rideActions('PASSENGER', trip('DRIVER_EN_ROUTE'), null).find(
      (a) => a.id === 'cancel',
    )!;
    expect(free.confirm?.message).not.toMatch(/fee/i);
    // the driver dropping out never mentions a passenger fee
    expect(
      rideActions('DRIVER', late, null).find((a) => a.id === 'cancel')!.confirm?.message,
    ).not.toMatch(/fee/i);
  });

  it('cancelled and no-driver rides have no actions', () => {
    expect(rideActions('PASSENGER', trip('CANCELLED'), null)).toEqual([]);
    expect(rideActions('PASSENGER', trip('NO_DRIVERS'), null)).toEqual([]);
  });
});

describe('words for money and outcomes', () => {
  it('says who pays whom, in words', () => {
    expect(paymentText('PASSENGER', 'PENDING', 350)).toBe(
      'Please pay your driver NPR 350 in cash.',
    );
    expect(paymentText('DRIVER', 'PENDING', 350)).toBe(
      'Collect NPR 350 in cash from the passenger, then confirm.',
    );
    expect(paymentText('PASSENGER', 'PAID', 350)).toBe('Payment NPR 350 received. Paid in cash.');
    expect(paymentText('PASSENGER', 'NONE', null)).toBe('');
  });

  it('describes how a ride ended for each side', () => {
    expect(
      outcomeText(
        { status: 'CANCELLED', cancelledBy: 'PASSENGER', cancelReason: null },
        'PASSENGER',
      ),
    ).toBe('Ride cancelled by you.');
    expect(
      outcomeText(
        { status: 'CANCELLED', cancelledBy: 'PASSENGER', cancelReason: 'Plans changed' },
        'DRIVER',
      ),
    ).toBe('Ride cancelled by the passenger. Reason: Plans changed.');
    expect(
      outcomeText({ status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: null }, 'DRIVER'),
    ).toBe('Ride cancelled by Yatri.');
    expect(
      outcomeText({ status: 'NO_DRIVERS', cancelledBy: null, cancelReason: null }, 'PASSENGER'),
    ).toBe('No driver was available.');
  });
});

describe('business rides billed to an organization', () => {
  const billed = {
    organizationName: 'Acme',
    purpose: 'Client visit',
    billedToOrganization: true,
    bookedByOther: true,
  };
  it('gives the driver nothing to collect', () => {
    const base = { status: 'COMPLETED' as const, paymentStatus: 'PENDING' as const, rated: true };
    expect(rideActions('DRIVER', base, null).map((a) => a.id)).toContain('confirmPayment');
    expect(
      rideActions('DRIVER', { ...base, billedToOrganization: true }, null).map((a) => a.id),
    ).not.toContain('confirmPayment');
  });
  it('says who pays, in words, to the rider and the driver', () => {
    expect(paymentText('PASSENGER', 'PENDING', 500, billed)).toBe(
      'Nothing to pay: Acme pays for this ride (NPR 500).',
    );
    expect(paymentText('DRIVER', 'PENDING', 500, billed)).toBe(
      'Nothing to collect: Acme is billed NPR 500 for this ride.',
    );
    expect(paymentText('PASSENGER', 'PENDING', 500, null)).toBe(
      'Please pay your driver NPR 500 in cash.',
    );
    expect(
      paymentText('PASSENGER', 'PENDING', 500, { ...billed, billedToOrganization: false }),
    ).toMatch(/in cash/);
  });
  it('names the business ride, who booked it and the purpose', () => {
    expect(businessText('PASSENGER', billed)).toBe(
      'Business ride for Acme, booked for you by someone there. Purpose: Client visit.',
    );
    expect(businessText('DRIVER', billed)).toBe(
      'Business ride for Acme. Purpose: Client visit. No cash to collect.',
    );
    expect(businessText('PASSENGER', { ...billed, purpose: null, bookedByOther: false })).toBe(
      'Business ride for Acme.',
    );
  });
});
