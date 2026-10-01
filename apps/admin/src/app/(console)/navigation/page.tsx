import Link from 'next/link';

import { getNavigationMetricsApi } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';

const percent = (v: number | null) => (v === null ? 'Not enough rides yet' : `${v}%`);

/**
 * How routing and arrival estimates are doing, for operations: counts and percentages across rides. There is no map
 * here and no driver or place: this answers "is routing working and are our estimates any good", never "where was this driver".
 */
export default async function NavigationPage() {
  const token = await requireAdminAccessToken();
  const { data: m, denied } = await loadOrDenied(() => getNavigationMetricsApi(token));
  if (denied || !m) return <NoAccess what="route and arrival-time figures" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Routes and arrival times</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        {m.rangeLabel}. Counts and percentages only; no driver, passenger or place appears here.
      </p>

      <section aria-labelledby="provider-h" style={styles.section}>
        <h2 id="provider-h" style={styles.sectionTitle}>
          Routing engine
        </h2>
        <ul>
          <li>In use: {m.provider.name}</li>
          <li>Turn-by-turn steps: {m.provider.steps ? 'supported' : 'not supported'}</li>
          <li>
            Live traffic in estimates:{' '}
            {m.provider.traffic
              ? 'supported'
              : 'not supported, so estimates do not include traffic'}
          </li>
        </ul>
      </section>

      <section aria-labelledby="routes-h" style={styles.section}>
        <h2 id="routes-h" style={styles.sectionTitle}>
          Routes
        </h2>
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
            Route figures
          </caption>
          <thead>
            <tr>
              {['Measure', 'Value'].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ['Routes planned', String(m.routesPlanned)],
              [
                'Routes that fell back to a straight-line guide',
                `${m.routeFallbacks} (${percent(m.fallbackPercent)} of routes)`,
              ],
              ['New routes planned after a deviation', String(m.reroutes)],
              ['Deviations confirmed', String(m.deviationsConfirmed)],
              ['Rides with at least one deviation', `${m.ridesWithDeviation} of ${m.ridesTotal}`],
              ['Pickup arrivals detected', String(m.arrivalsAtPickup)],
              ['Destination arrivals detected', String(m.arrivalsAtDestination)],
            ].map(([label, value]) => (
              <tr key={label}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  {label}
                </th>
                <td style={styles.td}>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ margin: 0 }}>
          A deviation is several accurate location readings in a row far from the planned route. It
          is not a fault of the driver: roadworks, closed streets and passenger requests cause it.
        </p>
      </section>

      <section aria-labelledby="eta-h" style={styles.section}>
        <h2 id="eta-h" style={styles.sectionTitle}>
          How good the arrival estimates are
        </h2>
        <ul>
          <li>Rides measured: {m.eta.samples}</li>
          <li>Within 20% of the real ride time: {percent(m.eta.withinTwentyPercent)}</li>
          <li>Average difference: {percent(m.eta.averageErrorPercent)}</li>
        </ul>
        <p style={{ margin: 0 }}>
          This compares the first estimate for each ride with how long it actually took. A
          consistently large difference means the routing data, or the speeds it assumes, need
          attention.
        </p>
      </section>
    </div>
  );
}
