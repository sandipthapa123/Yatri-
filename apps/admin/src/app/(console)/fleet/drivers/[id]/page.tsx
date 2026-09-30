import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OPERATIONAL_LABELS, VEHICLE_LIFECYCLE_LABELS } from '@yatri/types';

import { ApiError, getFleetDriver, getFleetOptions } from '../../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../../lib/session';
import { styles } from '../../../drivers/styles';
import { AuditTrail } from '../../../safety/AuditTrail';
import { DriverFleetForm, OperationalForm } from '../../Forms';
import { ExpiryTable, FleetNav } from '../../parts';

interface PageProps {
  params: Promise<{ id: string }>;
}

const AXES: Array<[keyof import('@yatri/types').FleetDriverDetail['axes'], string, string]> = [
  ['account', 'Account', 'Whether the account may sign in (the account system).'],
  ['verification', 'Verification', 'Whether the driver application and papers were approved.'],
  ['operational', 'Operational', 'Whether operations allows the driver to take rides (this page).'],
  ['availability', 'Availability', 'Whether the driver is online right now.'],
  ['ride', 'Ride', 'The status of the ride the driver is on, if any.'],
];

/**
 * One driver, with the five separate statuses side by side, each in words and each from its own model; whether
 * they can take rides (with every reason when they cannot); their vehicles, expiring papers, operational
 * controls and history.
 */
export default async function FleetDriverPage({ params }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  let d;
  try {
    d = await getFleetDriver(token, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const options = await getFleetOptions(token).catch(() => ({ fleets: [], categories: [] }));
  const word = (v: string) => (v === 'NONE' ? 'No ride' : v.toLowerCase().replace(/_/g, ' '));
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{d.name ?? 'Unnamed driver'}</h1>
        <Link href="/fleet/drivers" style={styles.backLink}>
          ← Drivers
        </Link>
      </div>
      <FleetNav />

      <section aria-labelledby="st-h" style={styles.section}>
        <h2 id="st-h" style={styles.sectionTitle}>
          Statuses
        </h2>
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
            The driver&apos;s separate statuses
          </caption>
          <thead>
            <tr>
              {['Status', 'Now', 'What it is'].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AXES.map(([key, label, what]) => (
              <tr key={key}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  {label}
                </th>
                <td style={styles.td}>
                  {key === 'operational'
                    ? OPERATIONAL_LABELS[d.operationalStatus]
                    : word(d.axes[key])}
                </td>
                <td style={styles.td}>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.operationalStatus !== 'ACTIVE' ? (
          <p style={{ margin: 0 }}>
            {OPERATIONAL_LABELS[d.operationalStatus]}
            {d.operationalReason ? `: ${d.operationalReason}` : ''}
            {d.operationalUntil ? `. Until ${new Date(d.operationalUntil).toLocaleString()}.` : '.'}
          </p>
        ) : null}
        {d.eligibility.eligible ? (
          <p style={{ margin: 0 }}>This driver can be offered rides.</p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              <strong>This driver cannot be offered rides, because:</strong>
            </p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {d.eligibility.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="op-h" style={styles.section}>
        <h2 id="op-h" style={styles.sectionTitle}>
          Suspension and restriction
        </h2>
        <OperationalForm
          driverId={d.id}
          current={d.operationalStatus}
          allowedNext={d.allowedNext}
        />
      </section>

      <section aria-labelledby="fl-h" style={styles.section}>
        <h2 id="fl-h" style={styles.sectionTitle}>
          Fleet
        </h2>
        <p style={{ margin: 0 }}>{d.fleetName ? `Member of ${d.fleetName}.` : 'Not in a fleet.'}</p>
        <DriverFleetForm driverId={d.id} current={d.fleetId} fleets={options.fleets} />
      </section>

      <section aria-labelledby="ve-h" style={styles.section}>
        <h2 id="ve-h" style={styles.sectionTitle}>
          Vehicles
        </h2>
        {d.vehicles.length === 0 ? (
          <p style={{ margin: 0 }}>No vehicles.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {d.vehicles.map((v) => (
              <li key={v.id}>
                <Link href={`/fleet/vehicles/${v.id}`}>{v.registrationNumber}</Link> (
                {v.description}): {VEHICLE_LIFECYCLE_LABELS[v.lifecycle]},{' '}
                {v.eligible ? 'can be used for rides' : 'cannot be used for rides'}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ex-h" style={styles.section}>
        <h2 id="ex-h" style={styles.sectionTitle}>
          Documents and dates
        </h2>
        <ExpiryTable items={d.expiry} label="Documents and dates of this driver" />
      </section>

      <AuditTrail entries={d.audit} />
    </div>
  );
}
