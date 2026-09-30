import Link from 'next/link';
import { notFound } from 'next/navigation';
import { VEHICLE_LIFECYCLE_LABELS } from '@yatri/types';

import { ApiError, getFleetVehicle, listFleetDriversApi } from '../../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../../lib/session';
import { styles } from '../../../drivers/styles';
import { AuditTrail } from '../../../safety/AuditTrail';
import {
  AssignVehicleForm,
  InspectionForm,
  LifecycleForm,
  MaintenanceCompleteForm,
  MaintenanceStartForm,
  ServiceLogForm,
  UnassignForm,
} from '../../Forms';
import { ExpiryTable, FleetNav, ServiceTable } from '../../parts';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * One vehicle: its status and whether it can be used for rides (with every reason when it cannot), who has
 * it, what is expiring, its inspections and maintenance, and the controls. The server decides what is possible;
 * the page shows what it reports.
 */
export default async function VehiclePage({ params }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  let v;
  try {
    v = await getFleetVehicle(token, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const drivers =
    v.assignable && v.fleetId
      ? ((await listFleetDriversApi(token, { fleetId: v.fleetId, pageSize: 100 }).catch(() => null))
          ?.items ?? [])
      : [];
  const openRepair = v.service.find((s) => s.status === 'IN_PROGRESS');
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Vehicle {v.registrationNumber}</h1>
        <Link href="/fleet/vehicles" style={styles.backLink}>
          ← Vehicles
        </Link>
      </div>
      <FleetNav />

      <section aria-labelledby="sum-h" style={styles.section}>
        <h2 id="sum-h" style={styles.sectionTitle}>
          Summary
        </h2>
        <p style={{ margin: 0 }}>
          <strong>{VEHICLE_LIFECYCLE_LABELS[v.lifecycle]}.</strong> {v.description}
          {v.categoryLabel ? `, ${v.categoryLabel}` : ''}. Review:{' '}
          {v.verificationStatus.toLowerCase()}. Fleet: {v.fleetName ?? 'none'}. Driver:{' '}
          {v.driverName ?? 'not assigned'}.
        </p>
        {v.eligibility.eligible ? (
          <p style={{ margin: 0 }}>This vehicle can be used for rides.</p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              <strong>This vehicle cannot be used for rides, because:</strong>
            </p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {v.eligibility.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        )}
        {v.driverId ? <Link href={`/fleet/drivers/${v.driverId}`}>Open the driver</Link> : null}
      </section>

      <section aria-labelledby="life-h" style={styles.section}>
        <h2 id="life-h" style={styles.sectionTitle}>
          Status
        </h2>
        <LifecycleForm vehicleId={v.id} current={v.lifecycle} allowedNext={v.allowedNext} />
      </section>

      <section aria-labelledby="asg-h" style={styles.section}>
        <h2 id="asg-h" style={styles.sectionTitle}>
          Driver
        </h2>
        {v.driverId ? (
          <>
            <p style={{ margin: 0 }}>Assigned to {v.driverName ?? 'a driver'}.</p>
            {v.fleetId ? (
              <UnassignForm vehicleId={v.id} />
            ) : (
              <p style={{ margin: 0 }}>
                This is the driver&apos;s own vehicle and stays with them.
              </p>
            )}
          </>
        ) : v.assignable && v.fleetId ? (
          <AssignVehicleForm
            vehicleId={v.id}
            drivers={drivers.map((d) => ({
              id: d.id,
              label: `${d.name ?? 'Unnamed driver'} (${d.eligible ? 'can take rides' : 'cannot take rides yet'})`,
            }))}
          />
        ) : (
          <p style={{ margin: 0 }}>This vehicle cannot be assigned in its current status.</p>
        )}
      </section>

      <section aria-labelledby="exp-h" style={styles.section}>
        <h2 id="exp-h" style={styles.sectionTitle}>
          Documents and dates
        </h2>
        <ExpiryTable items={v.expiry} label="Documents and dates of this vehicle" />
      </section>

      <section aria-labelledby="svc-h" style={styles.section}>
        <h2 id="svc-h" style={styles.sectionTitle}>
          Inspections and maintenance
        </h2>
        <ServiceTable records={v.service} />
        {openRepair ? (
          <>
            <h3 style={{ margin: 0, fontSize: 16 }}>Complete the maintenance in progress</h3>
            <MaintenanceCompleteForm record={openRepair} />
          </>
        ) : (
          <>
            <h3 style={{ margin: 0, fontSize: 16 }}>
              Take the vehicle out of service for maintenance
            </h3>
            <MaintenanceStartForm vehicleId={v.id} />
          </>
        )}
        <h3 style={{ margin: 0, fontSize: 16 }}>Record an inspection</h3>
        <InspectionForm vehicleId={v.id} />
        <h3 style={{ margin: 0, fontSize: 16 }}>Record a service</h3>
        <ServiceLogForm vehicleId={v.id} />
      </section>

      <AuditTrail entries={v.audit} />
    </div>
  );
}
