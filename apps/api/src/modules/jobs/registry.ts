import { env } from '../../config/env';
import { retryFailedNotifications } from '../../lib/notifications';
import { sweepDrivers } from '../availability/availability.service';
import { sweepCalls } from '../calls/calls.service';
import { runRetention } from '../compliance/retention.service';
import { sweepDispatch } from '../dispatch/dispatch.service';
import { runFleetMonitor } from '../fleet/monitor';
import { runOrganizationSweep } from '../organizations/sweep';
import { runRiskSweep } from '../risk/sweep';
import { expireDueShares } from '../sharing/sharing.service';
import { sweepSupport } from '../support/tickets.service';
import { sweepTrips } from '../trips/trip-maintenance';
import { reconcilePayments } from '../trips/payment-reconcile';
import type { JobDef } from './jobs';

/**
 * Every background job, in one list. Adding time-based work means adding a line here (and a function that finds what is
 * due by looking at the data); it never means starting a timer somewhere else. Intervals that were configurable stay
 * configurable through the same environment values.
 */
export const JOBS: readonly JobDef[] = [
  {
    name: 'trip-sweep',
    label: 'Expired and stalled rides',
    help: 'Ends searches that found no driver in time, reminds waiting drivers and riders, and drops rides whose driver went silent.',
    everySeconds: 10,
    run: () => sweepTrips(),
  },
  {
    name: 'dispatch-sweep',
    label: 'Ride offers',
    help: 'Expires unanswered offers and offers the ride to the next driver.',
    everySeconds: 5,
    run: () => sweepDispatch(),
  },
  {
    name: 'driver-sweep',
    label: 'Stale drivers',
    help: 'Takes drivers offline whose location stopped arriving, so nobody is offered a ride by someone who cannot be reached.',
    everySeconds: 15,
    run: () => sweepDrivers(),
  },
  {
    name: 'call-sweep',
    label: 'Unanswered calls',
    help: 'Ends calls nobody answered.',
    everySeconds: 10,
    run: async () => ({ ended: await sweepCalls() }),
  },
  {
    name: 'share-expiry',
    label: 'Trip sharing links',
    help: 'Stops sharing links whose period has ended.',
    everySeconds: 10,
    run: async () => ({ expired: await expireDueShares() }),
  },
  {
    name: 'notification-retry',
    label: 'Notification retries',
    help: 'Sends again the notifications whose push failed, with a back-off, and gives up after the last try.',
    everySeconds: 30,
    run: () => retryFailedNotifications(),
  },
  {
    name: 'payment-reconcile',
    label: 'Payment reconciliation',
    help: 'Creates the payment of a finished ride that has none, and reports statements and refunds that look wrong.',
    everySeconds: 600,
    run: () => reconcilePayments(),
  },
  {
    name: 'support-sweep',
    label: 'Support escalation and closing',
    help: 'Escalates requests nobody answered in time and closes the ones that were resolved.',
    everySeconds: env.SUPPORT_SWEEP_SECONDS,
    run: () => sweepSupport(),
  },
  {
    name: 'fleet-monitor',
    label: 'Document and service dates',
    help: 'Reminds drivers before documents, licences, registration, insurance and service dates run out, and takes ineligible drivers offline.',
    everySeconds: env.FLEET_MONITOR_MINUTES * 60,
    run: () => runFleetMonitor(),
  },
  {
    name: 'risk-sweep',
    label: 'Fraud and risk signals',
    help: 'Looks for patterns that need a person to review and raises signals.',
    everySeconds: env.RISK_SWEEP_MINUTES * 60,
    run: () => runRiskSweep(),
  },
  {
    name: 'organization-sweep',
    label: 'Business approvals and statements',
    help: 'Expires approvals nobody decided and issues last month’s statements.',
    everySeconds: env.ORG_SWEEP_MINUTES * 60,
    run: async () => {
      await runOrganizationSweep();
      return { done: true };
    },
  },
  {
    name: 'retention',
    label: 'Data retention',
    help: 'Deletes records that have passed the retention period set in Privacy and compliance.',
    everySeconds: 3600,
    run: () => runRetention(),
  },
];

export const jobByName = (name: string) => JOBS.find((j) => j.name === name);
