import Link from 'next/link';
import { CITY_STATUS_LABELS } from '@yatri/types';

import { listCitiesApi } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { CreateCityForm } from './Forms';

/** Every city Yatri is set up in: whether it is open now, how many service areas it has, and this month's activity. */
export default async function CitiesPage() {
  const token = await requireAdminAccessToken();
  const { data: cities, denied } = await loadOrDenied(() => listCitiesApi(token));
  if (denied || !cities) return <NoAccess what="cities and service areas" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Cities and service areas</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        A city is where Yatri operates under its own status, hours, vehicle types, fares and rules.
        Its boundary is its service areas. Everything not set for a city is the platform&apos;s
        value.
      </p>
      {cities.length === 0 ? (
        <p style={{ margin: 0 }}>
          No cities yet: the platform-wide rules apply everywhere a service area covers.
        </p>
      ) : (
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>Cities</caption>
          <thead>
            <tr>
              {[
                'City',
                'Province',
                'Status',
                'Open now',
                'Service areas',
                'Rides this month',
                'Drivers online',
              ].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cities.map((c) => (
              <tr key={c.id}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  <Link href={`/cities/${c.id}`}>{c.name}</Link>
                </th>
                <td style={styles.td}>{c.provinceName}</td>
                <td style={styles.td}>{CITY_STATUS_LABELS[c.status]}</td>
                <td style={styles.td}>{c.openNow ? 'Yes' : 'No'}</td>
                <td style={styles.td}>{c.zones}</td>
                <td style={styles.td}>{c.ridesThisMonth}</td>
                <td style={styles.td}>{c.driversOnlineNow}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <section aria-labelledby="new-h" style={styles.section}>
        <h2 id="new-h" style={styles.sectionTitle}>
          Add a city
        </h2>
        <CreateCityForm />
      </section>
    </div>
  );
}
