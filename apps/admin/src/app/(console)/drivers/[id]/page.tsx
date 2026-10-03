import { formatWhen } from '@yatri/types';
import Link from 'next/link';

import {
  getAdminDriverDetail,
  getAdminDriverDocuments,
  getAdminDriverHistory,
} from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { StatusBadge } from '../StatusBadge';
import { styles } from '../styles';
import { ActionButton } from './ActionButton';
import { ActionGuardProvider } from './ActionGuard';
import {
  approveVehicleAction,
  rejectDriverAction,
  rejectVehicleAction,
  suspendDriverAction,
  verifyDriverAction,
} from './actions';
import { DocumentRow } from './DocumentRow';
import { DriverTabs } from './DriverTabs';
import { ReasonDialogForm } from './ReasonDialogForm';

interface PageProps {
  params: Promise<{ id: string }>;
}

function fmtDate(value: string | null): string {
  return formatWhen(value, { empty: 'not recorded' });
}

export default async function DriverDetailPage({ params }: PageProps) {
  const { id: driverId } = await params;
  const accessToken = await requireAdminAccessToken();

  const [driver, documents, history] = await Promise.all([
    getAdminDriverDetail(accessToken, driverId),
    getAdminDriverDocuments(accessToken, driverId),
    getAdminDriverHistory(accessToken, driverId),
  ]);

  const canReview = driver.driverStatus === 'SUBMITTED' || driver.driverStatus === 'UNDER_REVIEW';
  const canSuspend = driver.driverStatus === 'VERIFIED';

  const personalInfoPanel = (
    <div style={styles.section}>
      <h2 style={styles.sectionTitle}>Personal information</h2>
      <dl style={styles.definitionList}>
        <dt style={styles.dt}>Full legal name</dt>
        <dd style={styles.dd}>{driver.details.fullLegalName ?? '—'}</dd>
        <dt style={styles.dt}>Date of birth</dt>
        <dd style={styles.dd}>{driver.details.dateOfBirth ?? '—'}</dd>
        <dt style={styles.dt}>Address</dt>
        <dd style={styles.dd}>
          {[driver.details.addressLine1, driver.details.addressLine2, driver.details.city]
            .filter(Boolean)
            .join(', ') || '—'}
        </dd>
        <dt style={styles.dt}>Emergency contact</dt>
        <dd style={styles.dd}>
          {driver.details.emergencyContactName
            ? `${driver.details.emergencyContactName} (${driver.details.emergencyContactPhone ?? 'no phone'})`
            : '—'}
        </dd>
      </dl>
      <h2 style={styles.sectionTitle}>Driver information</h2>
      <dl style={styles.definitionList}>
        <dt style={styles.dt}>Driving licence number</dt>
        <dd style={styles.dd}>{driver.details.licenseNumber ?? '—'}</dd>
        <dt style={styles.dt}>Licence expiry date</dt>
        <dd style={styles.dd}>{driver.details.licenseExpiryDate ?? '—'}</dd>
      </dl>
    </div>
  );

  const vehiclesPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {driver.vehicles.length === 0 ? (
        <p style={styles.emptyState}>No vehicles on file.</p>
      ) : (
        driver.vehicles.map((vehicle) => (
          <div key={vehicle.id} style={styles.section}>
            <div style={styles.headerRow}>
              <h2 style={styles.sectionTitle}>
                {vehicle.year} {vehicle.make} {vehicle.model}
              </h2>
              <StatusBadge status={vehicle.verificationStatus} />
            </div>
            <dl style={styles.definitionList}>
              <dt style={styles.dt}>Registration number</dt>
              <dd style={styles.dd}>{vehicle.registrationNumber}</dd>
              <dt style={styles.dt}>Colour</dt>
              <dd style={styles.dd}>{vehicle.color}</dd>
              <dt style={styles.dt}>VIN</dt>
              <dd style={styles.dd}>{vehicle.vin ?? '—'}</dd>
              <dt style={styles.dt}>Registration expiry</dt>
              <dd style={styles.dd}>{vehicle.registrationExpiryDate ?? '—'}</dd>
              <dt style={styles.dt}>Insurance provider</dt>
              <dd style={styles.dd}>{vehicle.insuranceProvider ?? '—'}</dd>
              <dt style={styles.dt}>Insurance policy number</dt>
              <dd style={styles.dd}>{vehicle.insurancePolicyNumber ?? '—'}</dd>
              <dt style={styles.dt}>Insurance expiry</dt>
              <dd style={styles.dd}>{vehicle.insuranceExpiryDate ?? '—'}</dd>
              {vehicle.verificationStatus === 'REJECTED' && vehicle.rejectionReason ? (
                <>
                  <dt style={styles.dt}>Rejection reason</dt>
                  <dd style={{ ...styles.dd, color: 'var(--color-error)' }}>
                    {vehicle.rejectionReason}
                  </dd>
                </>
              ) : null}
            </dl>
            <div style={styles.buttonRow}>
              <ActionButton
                action={approveVehicleAction}
                fields={{ driverId: driver.id, vehicleId: vehicle.id }}
                label="Approve vehicle"
              />
              <ReasonDialogForm
                action={rejectVehicleAction}
                fields={{ driverId: driver.id, vehicleId: vehicle.id }}
                triggerLabel="Reject vehicle"
                dialogTitle={`Reject ${vehicle.make} ${vehicle.model}`}
                submitLabel="Reject vehicle"
              />
            </div>
          </div>
        ))
      )}
    </div>
  );

  const documentsPanel = (
    <div style={styles.section}>
      {documents.length === 0 ? (
        <p style={styles.emptyState}>No documents uploaded yet.</p>
      ) : (
        documents.map((doc) => <DocumentRow key={doc.id} document={doc} driverId={driver.id} />)
      )}
    </div>
  );

  const historyPanel = (
    <div style={styles.section}>
      {history.length === 0 ? (
        <p style={styles.emptyState}>No verification history yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {history.map((event) => (
            <li key={event.id} style={styles.historyItem}>
              <strong>{event.action.replaceAll('_', ' ')}</strong>{' '}
              {event.previousStatus && event.newStatus
                ? `(${event.previousStatus} → ${event.newStatus})`
                : null}
              <br />
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {fmtDate(event.createdAt)} · {event.actorUserId ? 'By admin' : 'By driver'}
              </span>
              {event.reason ? (
                <>
                  <br />
                  <span>Reason: {event.reason}</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <ActionGuardProvider>
      <div style={styles.page}>
        <Link href="/drivers" style={styles.backLink}>
          ← All applications
        </Link>

        <div style={styles.headerRow}>
          <div>
            <h1 style={styles.title}>{driver.fullName ?? 'Unnamed driver'}</h1>
            <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)' }}>
              {driver.phoneNumber ?? 'No phone on file'}
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Verification status
            </p>
            <StatusBadge status={driver.driverStatus} />
          </div>
        </div>

        {driver.driverStatus === 'REJECTED' && driver.rejectionReason ? (
          <div role="alert" style={styles.section}>
            <p style={{ margin: 0, fontWeight: 700, color: 'var(--color-error)' }}>
              Rejected — reason given to driver
            </p>
            <p style={{ margin: '4px 0 0' }}>{driver.rejectionReason}</p>
          </div>
        ) : null}

        {canReview || canSuspend ? (
          <div style={styles.buttonRow}>
            {canReview ? (
              <>
                <ActionButton
                  action={verifyDriverAction}
                  fields={{ driverId: driver.id }}
                  label="Approve driver"
                />
                <ReasonDialogForm
                  action={rejectDriverAction}
                  fields={{ driverId: driver.id }}
                  triggerLabel="Reject driver"
                  dialogTitle="Reject this application"
                  submitLabel="Reject application"
                />
              </>
            ) : null}
            {canSuspend ? (
              <ReasonDialogForm
                action={suspendDriverAction}
                fields={{ driverId: driver.id }}
                triggerLabel="Suspend driver"
                dialogTitle="Suspend this driver"
                submitLabel="Suspend driver"
              />
            ) : null}
          </div>
        ) : null}

        <DriverTabs
          tabs={[
            { id: 'info', label: 'Driver info', panel: personalInfoPanel },
            { id: 'vehicles', label: 'Vehicles', panel: vehiclesPanel },
            { id: 'documents', label: `Documents (${documents.length})`, panel: documentsPanel },
            { id: 'history', label: 'History', panel: historyPanel },
          ]}
        />
      </div>
    </ActionGuardProvider>
  );
}
