import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ACTIVE_TRIP_STATUSES,
  describeTripEvent,
  formatDistance,
  formatElapsed,
  formatNpr,
  PAYMENT_STATUS_LABELS,
  TRIP_STATUS_LABELS,
} from '@yatri/types';

import { ApiError, getAdminTrip } from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { ResolveDisputeForm, CancelRideForm } from '../ActionForms';
import { AutoRefresh } from '../AutoRefresh';

interface PageProps {
  params: Promise<{ id: string }>;
}

const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const FRESHNESS_TEXT: Record<string, string> = {
  fresh: 'Fresh',
  stale: 'Stale',
  none: 'No location',
};
const CALL_STATE_TEXT: Record<string, string> = {
  RINGING: 'Ringing',
  CONNECTING: 'Connecting',
  CONNECTED: 'Connected',
  ENDED: 'Ended',
};

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl style={styles.definitionList}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={styles.dt}>{k}</dt>
          <dd style={styles.dd}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One ride, end to end, from the same records the passenger and driver apps use: the state
 * machine's events, dispatch history, waiting, location freshness, calls, chat counts, payment,
 * ratings and disputes. Sensitive data is permissioned: exact driver coordinates need
 * DRIVER_LOCATION_VIEW and chat text needs TRIP_CHAT_VIEW, and both are written to the access log.
 */
export default async function RideDetailPage({ params }: PageProps) {
  const accessToken = await requireAdminAccessToken();
  const { id } = await params;
  let d;
  try {
    d = await getAdminTrip(accessToken, id);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  const live = (ACTIVE_TRIP_STATUSES as readonly string[]).includes(d.status);
  const w = d.waiting;

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Ride: {TRIP_STATUS_LABELS[d.status]}</h1>
        <Link href="/rides" style={styles.backLink}>
          ← All rides
        </Link>
      </div>
      {live ? <AutoRefresh /> : null}

      <section style={styles.section} aria-labelledby="summary">
        <h2 id="summary" style={styles.sectionTitle}>
          Summary
        </h2>
        <Facts
          rows={[
            ['Status', TRIP_STATUS_LABELS[d.status]],
            ['Vehicle type', d.vehicleCategory?.label ?? 'Not recorded'],
            ['Passenger', d.passenger.name ?? 'Unnamed'],
            ['Driver', d.driver ? (d.driver.name ?? 'Unnamed') : 'Not assigned'],
            ['Pickup', `${d.pickup.name}, ${d.pickup.address}`],
            ['Destination', `${d.destination.name}, ${d.destination.address}`],
            ['Requested', at(d.requestedAt)],
            ['Driver assigned', at(d.matchedAt)],
            ['Driver arrived', at(d.arrivedAt)],
            ['Ride started', at(d.startedAt)],
            ['Ride ended', at(d.endedAt)],
            ...(d.cancelledBy
              ? ([
                  ['Cancelled by', d.cancelledBy],
                  ['Cancel reason', d.cancelReason ?? 'None given'],
                  [
                    'Cancelled from',
                    d.cancelledFromStatus ? TRIP_STATUS_LABELS[d.cancelledFromStatus] : 'Unknown',
                  ],
                  [
                    'Cancellation fee',
                    d.cancellationFeeNpr > 0
                      ? `${formatNpr(d.cancellationFeeNpr)} recorded (not charged)`
                      : 'None',
                  ],
                ] as Array<[string, string]>)
              : []),
          ]}
        />
      </section>

      <section style={styles.section} aria-labelledby="live">
        <h2 id="live" style={styles.sectionTitle}>
          Waiting and location
        </h2>
        <Facts
          rows={[
            [
              'Waiting',
              w?.driver
                ? `Driver has waited ${formatElapsed(w.driver.seconds)} at the pickup${w.affectsFare ? ` (charged: ${formatNpr(w.chargeNpr)})` : ' (within the free period)'}`
                : w?.passenger
                  ? `Passenger has waited ${formatElapsed(w.passenger.seconds)} for the driver (never charged)`
                  : 'Nobody is waiting',
            ],
            [
              'Driver location',
              FRESHNESS_TEXT[d.location.driverFreshness] ?? d.location.driverFreshness,
            ],
            ['Last location update', at(d.location.lastUpdateAt)],
            [
              'Driver position',
              d.location.driverPosition
                ? `${d.location.driverPosition.latitude.toFixed(5)}, ${d.location.driverPosition.longitude.toFixed(5)}`
                : 'Restricted (needs the driver location-view permission)',
            ],
          ]}
        />
      </section>

      <section style={styles.section} aria-labelledby="money">
        <h2 id="money" style={styles.sectionTitle}>
          Fare and payment
        </h2>
        {d.fare ? (
          <Facts
            rows={[
              ['Distance', formatDistance(d.fare.distanceMeters)],
              ['Estimate', formatNpr(d.fare.estimateNpr)],
              ['Waiting charge', formatNpr(d.fare.waitingChargeNpr)],
              [
                'Final fare',
                d.fare.finalNpr === null ? 'Not final yet' : formatNpr(d.fare.finalNpr),
              ],
              [
                'Payment',
                d.payment
                  ? `${PAYMENT_STATUS_LABELS[d.payment.status]}, ${formatNpr(d.payment.amountNpr)}${d.payment.paidAt ? `, ${at(d.payment.paidAt)}` : ''}`
                  : 'No payment record yet',
              ],
            ]}
          />
        ) : (
          <p style={{ margin: 0 }}>No fare recorded.</p>
        )}
      </section>

      <section style={styles.section} aria-labelledby="matching">
        <h2 id="matching" style={styles.sectionTitle}>
          Matching
        </h2>
        {d.offers.length === 0 ? (
          <p style={{ margin: 0 }}>No driver was offered this ride.</p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
              Drivers offered this ride, in order
            </caption>
            <thead>
              <tr>
                {['Driver', 'Outcome', 'Distance to pickup', 'Offered', 'Answered'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.offers.map((o) => (
                <tr key={`${o.driverName}-${o.offeredAt}`}>
                  <td style={styles.td}>{o.driverName ?? 'Unnamed'}</td>
                  <td style={styles.td}>{o.status}</td>
                  <td style={styles.td}>{formatDistance(o.pickupDistanceMeters)}</td>
                  <td style={styles.td}>{at(o.offeredAt)}</td>
                  <td style={styles.td}>{at(o.respondedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={styles.section} aria-labelledby="comms">
        <h2 id="comms" style={styles.sectionTitle}>
          Chat and calls
        </h2>
        <p style={{ margin: 0 }}>
          {d.chat.messageCount} chat message{d.chat.messageCount === 1 ? '' : 's'}.{' '}
          {d.chat.canViewContent ? (
            d.chat.messageCount > 0 ? (
              <Link href={`/rides/${d.id}/chat`}>Read the conversation (this is logged)</Link>
            ) : null
          ) : (
            'Message text is restricted (needs the chat-view permission).'
          )}
        </p>
        {d.calls.length === 0 ? (
          <p style={{ margin: 0 }}>No calls on this ride.</p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
              Calls made during this ride
            </caption>
            <thead>
              <tr>
                {['Type', 'Started by', 'State', 'Started', 'Connected', 'Ended', 'Reason'].map(
                  (h) => (
                    <th key={h} scope="col" style={styles.th}>
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {d.calls.map((c) => (
                <tr key={c.id}>
                  <td style={styles.td}>{c.kind === 'VIDEO' ? 'Video' : 'Audio'}</td>
                  <td style={styles.td}>{c.callerRole === 'PASSENGER' ? 'Passenger' : 'Driver'}</td>
                  <td style={styles.td}>{CALL_STATE_TEXT[c.state] ?? c.state}</td>
                  <td style={styles.td}>{at(c.createdAt)}</td>
                  <td style={styles.td}>{at(c.connectedAt)}</td>
                  <td style={styles.td}>{at(c.endedAt)}</td>
                  <td style={styles.td}>{c.endReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Call audio and video are never recorded or stored, and phone numbers are never exchanged.
        </p>
      </section>

      <section style={styles.section} aria-labelledby="timeline">
        <h2 id="timeline" style={styles.sectionTitle}>
          Timeline
        </h2>
        <ol
          style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          {d.events.map((e) => (
            <li key={e.seq} style={{ fontSize: 14 }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>{at(e.createdAt)}</span>{' '}
              {describeTripEvent(e, 'ADMIN')}
            </li>
          ))}
        </ol>
      </section>

      <section style={styles.section} aria-labelledby="ratings">
        <h2 id="ratings" style={styles.sectionTitle}>
          Ratings
        </h2>
        {d.ratings.length === 0 ? (
          <p style={{ margin: 0 }}>No ratings yet.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {d.ratings.map((r) => (
              <li key={r.raterRole}>
                {r.raterRole === 'PASSENGER' ? 'Passenger' : 'Driver'} gave {r.stars} out of 5
                {r.comment ? `: ${r.comment}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={styles.section} aria-labelledby="disputes">
        <h2 id="disputes" style={styles.sectionTitle}>
          Disputes
        </h2>
        {d.disputes.length === 0 ? (
          <p style={{ margin: 0 }}>No problems have been reported.</p>
        ) : (
          d.disputes.map((x) => (
            <article key={x.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ margin: 0 }}>
                <strong>{x.raisedByRole === 'PASSENGER' ? 'Passenger' : 'Driver'}</strong> reported
                ({x.status.toLowerCase()}
                ), {at(x.createdAt)}: {x.reason}
              </p>
              {x.resolution ? <p style={{ margin: 0 }}>Decision: {x.resolution}</p> : null}
              {x.status === 'OPEN' ? <ResolveDisputeForm disputeId={x.id} /> : null}
            </article>
          ))
        )}
      </section>

      {live ? (
        <section style={styles.section} aria-labelledby="actions">
          <h2 id="actions" style={styles.sectionTitle}>
            Operator action
          </h2>
          <CancelRideForm tripId={d.id} />
        </section>
      ) : null}
    </div>
  );
}
