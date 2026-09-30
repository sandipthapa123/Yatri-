import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FLEET_STATUS_LABELS, OPERATIONAL_LABELS, VEHICLE_LIFECYCLE_LABELS } from '@yatri/types';

import { ApiError, getFleet, getFleetOptions } from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { AuditTrail } from '../../safety/AuditTrail';
import { FleetForm, FleetVehicleForm } from '../Forms';
import { FleetNav } from '../parts';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** One fleet: contact and status, its drivers and vehicles (each with its status in words), and its history. */
export default async function FleetPage({ params }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  let fleet;
  try {
    fleet = await getFleet(token, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const options = await getFleetOptions(token).catch(() => ({ fleets: [], categories: [] }));
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{fleet.name}</h1>
        <Link href="/fleet" style={styles.backLink}>
          ← Fleets
        </Link>
      </div>
      <FleetNav />

      <section aria-labelledby="sum-h" style={styles.section}>
        <h2 id="sum-h" style={styles.sectionTitle}>
          The fleet
        </h2>
        <p style={{ margin: 0 }}>
          <strong>{FLEET_STATUS_LABELS[fleet.status]}.</strong> Contact:{' '}
          {[fleet.contactName, fleet.contactPhone, fleet.contactEmail].filter(Boolean).join(', ') ||
            'none recorded'}
          . {fleet.driverCount} driver{fleet.driverCount === 1 ? '' : 's'}, {fleet.vehicleCount}{' '}
          vehicle{fleet.vehicleCount === 1 ? '' : 's'}.
        </p>
        <FleetForm fleet={fleet} />
      </section>

      <section aria-labelledby="dr-h" style={styles.section}>
        <h2 id="dr-h" style={styles.sectionTitle}>
          Drivers
        </h2>
        {fleet.drivers.length === 0 ? (
          <p style={{ margin: 0 }}>No drivers. Add one from the driver&apos;s page.</p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
              Drivers of this fleet
            </caption>
            <thead>
              <tr>
                {['Driver', 'Operational status', 'Vehicles', 'Can take rides'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fleet.drivers.map((d) => (
                <tr key={d.id}>
                  <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                    <Link href={`/fleet/drivers/${d.id}`}>{d.name ?? 'Unnamed driver'}</Link>
                  </th>
                  <td style={styles.td}>{OPERATIONAL_LABELS[d.operationalStatus]}</td>
                  <td style={styles.td}>{d.vehicleCount}</td>
                  <td style={styles.td}>{d.eligible ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="ve-h" style={styles.section}>
        <h2 id="ve-h" style={styles.sectionTitle}>
          Vehicles
        </h2>
        {fleet.vehicles.length === 0 ? (
          <p style={{ margin: 0 }}>No vehicles yet.</p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
              Vehicles of this fleet
            </caption>
            <thead>
              <tr>
                {['Vehicle', 'Status', 'Driver', 'Can be used for rides'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fleet.vehicles.map((v) => (
                <tr key={v.id}>
                  <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                    <Link href={`/fleet/vehicles/${v.id}`}>{v.registrationNumber}</Link> (
                    {v.description})
                  </th>
                  <td style={styles.td}>{VEHICLE_LIFECYCLE_LABELS[v.lifecycle]}</td>
                  <td style={styles.td}>{v.driverName ?? 'Not assigned'}</td>
                  <td style={styles.td}>{v.eligible ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3 style={{ margin: 0, fontSize: 16 }}>Add a vehicle to this fleet</h3>
        <FleetVehicleForm fleetId={fleet.id} categories={options.categories} />
      </section>

      <AuditTrail entries={fleet.audit} />
    </div>
  );
}
