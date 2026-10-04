import { Facts } from '../ui/Facts';
import {
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_STATUS_LABELS,
  describeRatingSummary,
  formatNpr,
  type IncidentCategory,
  type IncidentStatus,
} from '@yatri/types';

import { getAnalytics } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { RangeFilter, rangeParamsOf } from '../ui/RangeFilter';

interface PageProps {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}

const pct = (n: number | null) => (n === null ? 'No rides ended yet' : `${n}%`);
const num = (n: number | null) => (n === null ? '—' : String(n));

/**
 * Analytics for a chosen period, computed by the API from the live records (no separate analytics
 * store). Everything is shown as words and tables, so nothing depends on seeing a chart. The
 * definitions at the bottom say exactly what each figure counts.
 */
export default async function AnalyticsPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const { data: a, denied } = await loadOrDenied(() => getAnalytics(token, rangeParamsOf(sp)));
  if (denied || !a) return <NoAccess what="analytics" />;

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Analytics</h1>
      <RangeFilter
        range={sp.range}
        from={sp.from}
        to={sp.to}
        defaultPreset="30d"
        resolved={a.range}
      />

      <section aria-labelledby="rides-h" style={styles.section}>
        <h2 id="rides-h" style={styles.sectionTitle}>
          Ride volume
        </h2>
        <Facts
          rows={[
            ['Rides requested', String(a.rides.requested)],
            ['Completed', String(a.rides.completed)],
            ['Cancelled', String(a.rides.cancelled)],
            ['No driver found', String(a.rides.noDrivers)],
            ['Still in progress', String(a.rides.stillActive)],
            ['Completion rate', pct(a.rides.completionRatePercent)],
            ['Cancellation rate', pct(a.rides.cancellationRatePercent)],
          ]}
        />
        <div className="table-scroll">
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
              Rides by day requested
            </caption>
            <thead>
              <tr>
                {['Day', 'Requested', 'Completed', 'Cancelled', 'Fares of completed rides'].map(
                  (h) => (
                    <th key={h} scope="col" style={styles.th}>
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {a.rides.daily.map((d) => (
                <tr key={d.day}>
                  <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                    {d.day}
                  </th>
                  <td style={styles.td}>{d.requested}</td>
                  <td style={styles.td}>{d.completed}</td>
                  <td style={styles.td}>{d.cancelled}</td>
                  <td style={styles.td}>{formatNpr(d.grossFaresNpr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="money-h" style={styles.section}>
        <h2 id="money-h" style={styles.sectionTitle}>
          Revenue and earnings
        </h2>
        <Facts
          rows={[
            ['Fares of completed rides (revenue)', formatNpr(a.money.grossFaresNpr)],
            [
              'Average fare',
              a.money.averageFareNpr === null ? '—' : formatNpr(a.money.averageFareNpr),
            ],
            ['Driver earnings', formatNpr(a.money.driverEarningsNpr)],
            ['Payments confirmed as received (cash and online)', formatNpr(a.money.collectedNpr)],
            ['Not yet confirmed', formatNpr(a.money.outstandingNpr)],
            ['Cancellation fees recorded', formatNpr(a.money.cancellationFeesNpr)],
            ['Owed to drivers for online rides, ready now', formatNpr(a.money.payouts.readyNpr)],
            ['Paid out to drivers', formatNpr(a.money.payouts.paidNpr)],
          ]}
        />
      </section>

      <section aria-labelledby="people-h" style={styles.section}>
        <h2 id="people-h" style={styles.sectionTitle}>
          Driver and passenger activity
        </h2>
        <Facts
          rows={[
            ['Drivers who completed a ride', String(a.drivers.active)],
            ['New drivers registered', String(a.drivers.newlyRegistered)],
            ['Completed rides per active driver', num(a.drivers.ridesPerActiveDriver)],
            ['Passengers who requested a ride', String(a.passengers.active)],
            ['New passengers registered', String(a.passengers.newlyRegistered)],
            ['Rides requested per active passenger', num(a.passengers.ridesPerActivePassenger)],
          ]}
        />
      </section>

      <section aria-labelledby="safety-h" style={styles.section}>
        <h2 id="safety-h" style={styles.sectionTitle}>
          Safety and quality
        </h2>
        <Facts
          rows={[
            ['Safety incident reports', String(a.safety.incidents)],
            ...(
              Object.entries(a.safety.incidentsByCategory) as Array<[IncidentCategory, number]>
            ).map(([c, n]): [string, string] => [
              `Reports: ${INCIDENT_CATEGORY_LABELS[c]}`,
              String(n),
            ]),
            ...(Object.entries(a.safety.incidentsByStatus) as Array<[IncidentStatus, number]>).map(
              ([s, n]): [string, string] => [
                `Reports now: ${INCIDENT_STATUS_LABELS[s]}`,
                String(n),
              ],
            ),
            ['SOS alerts', String(a.safety.sosAlerts)],
            ['Disputes reported', String(a.safety.disputes)],
            ['Low ratings (1 or 2 stars)', String(a.safety.lowRatings)],
            ['Ratings given', describeRatingSummary(a.ratings)],
          ]}
        />
      </section>

      <section aria-labelledby="def-h" style={styles.section}>
        <h2 id="def-h" style={styles.sectionTitle}>
          What these figures count
        </h2>
        <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          <li>A ride belongs to the day it was requested, in {a.range.timeZone} time.</li>
          <li>
            Completion and cancellation rates are of rides that have ended (completed, cancelled or
            no driver found); a ride still in progress counts against neither.
          </li>
          <li>
            Revenue is the sum of final fares of completed rides. Yatri has no commission, so it is
            also what drivers earned.
          </li>
          <li>
            Payments confirmed is what was received, in cash (confirmed by the driver) or online
            (confirmed by the payment provider); the rest is not yet confirmed.
          </li>
        </ul>
      </section>
    </div>
  );
}
