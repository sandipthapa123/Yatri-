import Link from 'next/link';
import { VEHICLE_CAPABILITY_LABELS } from '@yatri/types';

import {
  getAccessibilityStatsApi,
  listAccessibilityReviewsApi,
  listAttributesApi,
} from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { AttributeForm, DecideForm } from './Forms';

const list = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
} as const;

/**
 * Accessible rides, for the people who run them: how many rides needed an accessible vehicle and whether they were
 * matched (counts only, nobody named), who is waiting for approval, and the list of vehicle features. Everything an
 * administrator changes is checked, reasoned and audited by the API.
 */
export default async function AccessibilityPage() {
  const token = await requireAdminAccessToken();
  const [stats, reviews, attributes] = await Promise.all([
    loadOrDenied(() => getAccessibilityStatsApi(token)),
    loadOrDenied(() => listAccessibilityReviewsApi(token)),
    loadOrDenied(() => listAttributesApi(token)),
  ]);
  if (stats.denied || !stats.data || !reviews.data || !attributes.data) {
    return <NoAccess what="accessibility" />;
  }
  const s = stats.data;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Accessible rides</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        Passengers say what they need; drivers say what their vehicle has; the matching system only
        offers a ride to a vehicle that has what the ride needs. Only counts are shown here, never a
        person&apos;s needs.
      </p>

      <section aria-labelledby="stats-h" style={styles.section}>
        <h2 id="stats-h" style={styles.sectionTitle}>
          {s.rangeLabel}
        </h2>
        <ul>
          <li>Rides requested with any accessibility need: {s.ridesRequestedWithNeeds}</li>
          <li>Rides that needed an accessible vehicle: {s.ridesNeedingAccessibleVehicle}</li>
          <li>of those, matched with a driver: {s.ridesNeedingAccessibleVehicleMatched}</li>
          <li>of those, no driver found: {s.ridesNeedingAccessibleVehicleUnmatched}</li>
          <li>Wheelchair accessible vehicles approved: {s.accessibleVehiclesApproved}</li>
          <li>of those, with a driver online now: {s.accessibleVehiclesOnlineNow}</li>
        </ul>
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
            Vehicles by accessibility feature
          </caption>
          <thead>
            <tr>
              {['Feature', 'Approved vehicles', 'With a driver online now'].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.byAttribute.map((a) => (
              <tr key={a.code}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  {a.label}
                </th>
                <td style={styles.td}>{a.approvedVehicles}</td>
                <td style={styles.td}>{a.onlineNow}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="review-h" style={styles.section}>
        <h2 id="review-h" style={styles.sectionTitle}>
          Waiting for approval ({reviews.data.length})
        </h2>
        {reviews.data.length === 0 ? (
          <p style={{ margin: 0 }}>Nothing is waiting for approval.</p>
        ) : (
          <ul style={list}>
            {reviews.data.map((r) => (
              <li key={`${r.vehicleId}-${r.attributeCode}`}>
                <h3 style={{ margin: 0, fontSize: 16 }}>
                  {r.attributeLabel}: {r.vehicle}
                </h3>
                <p style={{ margin: '4px 0' }}>
                  Driver: {r.driverName ?? 'not named'}. Status: {VEHICLE_CAPABILITY_LABELS.PENDING}
                  . Declared {new Date(r.declaredAt).toLocaleString()}.
                </p>
                <DecideForm
                  vehicleId={r.vehicleId}
                  code={r.attributeCode}
                  what={`${r.attributeLabel} on ${r.vehicle}`}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="features-h" style={styles.section}>
        <h2 id="features-h" style={styles.sectionTitle}>
          Vehicle features
        </h2>
        <ul style={list}>
          {attributes.data.map((a) => (
            <li key={a.code}>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                {a.label} ({a.active ? 'in use' : 'switched off'}
                {a.core ? ', needed for matching' : ''})
              </h3>
              <details>
                <summary>Edit {a.label}</summary>
                <AttributeForm attribute={a} />
              </details>
            </li>
          ))}
        </ul>
        <h3 style={{ fontSize: 16 }}>Add a feature</h3>
        <AttributeForm />
      </section>
    </div>
  );
}
