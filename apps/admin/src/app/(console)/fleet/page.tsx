import Link from 'next/link';
import { FLEET_STATUS_LABELS } from '@yatri/types';

import { listFleetsApi } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { CheckNowButton, FleetForm } from './Forms';
import { FleetNav } from './parts';

/** Fleets (operators): who they are, how many vehicles and drivers each has, and whether they are active. */
export default async function FleetsPage() {
  const token = await requireAdminAccessToken();
  const { data: fleets, denied } = await loadOrDenied(() => listFleetsApi(token));
  if (denied || !fleets) return <NoAccess what="fleets and driver operations" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Fleets and driver operations</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <FleetNav />

      <section aria-labelledby="fl-h" style={styles.section}>
        <h2 id="fl-h" style={styles.sectionTitle}>
          Fleets
        </h2>
        {fleets.length === 0 ? (
          <p style={{ margin: 0 }}>
            No fleets yet. Drivers who are not in a fleet drive their own vehicles.
          </p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
              Fleets
            </caption>
            <thead>
              <tr>
                {['Fleet', 'Status', 'Contact', 'Vehicles', 'Drivers'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fleets.map((f) => (
                <tr key={f.id}>
                  <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                    <Link href={`/fleet/${f.id}`}>{f.name}</Link>
                  </th>
                  <td style={styles.td}>{FLEET_STATUS_LABELS[f.status]}</td>
                  <td style={styles.td}>
                    {[f.contactName, f.contactPhone, f.contactEmail].filter(Boolean).join(', ') ||
                      '—'}
                  </td>
                  <td style={styles.td}>{f.vehicleCount}</td>
                  <td style={styles.td}>{f.driverCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="new-h" style={styles.section}>
        <h2 id="new-h" style={styles.sectionTitle}>
          Add a fleet
        </h2>
        <FleetForm />
      </section>

      <section aria-labelledby="chk-h" style={styles.section}>
        <h2 id="chk-h" style={styles.sectionTitle}>
          Expiry check
        </h2>
        <p style={{ margin: 0 }}>
          Documents, licences, registrations, insurance and service dates are checked every hour:
          drivers are reminded, and a driver who can no longer take rides is taken offline.
        </p>
        <CheckNowButton />
      </section>
    </div>
  );
}
