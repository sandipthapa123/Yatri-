import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ACCOUNT_STATUS_LABELS,
  describeRatingSummary,
  ROLE_LABELS,
  TRIP_STATUS_LABELS,
} from '@yatri/types';

import { ApiError, getAdminUser } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { AuditTrail } from '../../safety/AuditTrail';
import { ConfirmAction } from '../../ui/ConfirmAction';
import { NoAccess } from '../../ui/NoAccess';
import { userStatusAction } from '../actions';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** One account. Opening it is recorded (it shows a phone number and email). */
export default async function UserDetailPage({ params }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  let result;
  try {
    result = await loadOrDenied(() => getAdminUser(token, id));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  if (result.denied) return <NoAccess what="user accounts" />;
  const u = result.data;
  const rows: Array<[string, string]> = [
    ['Role', ROLE_LABELS[u.role]],
    ['Account status', ACCOUNT_STATUS_LABELS[u.status]],
    ['Phone', u.phoneNumber ?? '—'],
    ['Email', u.email ?? '—'],
    ['Joined', new Date(u.createdAt).toLocaleString()],
    ['Driver verification', u.driverStatus ?? '—'],
    ['Rides requested or driven', String(u.ridesRequested)],
    ['Rides completed', String(u.ridesCompleted)],
    ['Rides cancelled', String(u.ridesCancelled)],
    ['Rating', describeRatingSummary(u.rating)],
    ['Ride in progress', u.activeRide ? TRIP_STATUS_LABELS[u.activeRide.status] : 'None'],
  ];
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{u.fullName ?? 'Unnamed user'}</h1>
        <Link href="/users" style={styles.backLink}>
          ← Users
        </Link>
      </div>

      <section aria-labelledby="det-h" style={styles.section}>
        <h2 id="det-h" style={styles.sectionTitle}>
          Details
        </h2>
        <dl style={styles.definitionList}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt style={styles.dt}>{k}</dt>
              <dd style={styles.dd}>{v}</dd>
            </div>
          ))}
        </dl>
        {u.activeRide ? (
          <Link href={`/rides/${u.activeRide.tripId}`}>Open the ride in progress</Link>
        ) : null}
        {u.role === 'DRIVER' ? (
          <Link href={`/drivers/${u.id}`}>Open the driver verification file</Link>
        ) : null}
      </section>

      <section aria-labelledby="act-h" style={styles.section}>
        <h2 id="act-h" style={styles.sectionTitle}>
          Account status
        </h2>
        {u.canSuspend ? (
          <ConfirmAction
            action={userStatusAction}
            hidden={{ userId: u.id, to: 'suspend' }}
            label="Suspend this account"
            consequence="They will be signed out everywhere and cannot sign in until reactivated. A driver is taken off the road."
            confirmLabel="Yes, suspend this account"
          />
        ) : null}
        {u.canReactivate ? (
          <ConfirmAction
            action={userStatusAction}
            hidden={{ userId: u.id, to: 'reactivate' }}
            label="Reactivate this account"
            consequence="They will be able to sign in again."
            confirmLabel="Yes, reactivate this account"
            tone="primary"
          />
        ) : null}
        {!u.canSuspend && !u.canReactivate ? (
          <p style={{ margin: 0 }}>
            {u.status === 'DEACTIVATED'
              ? 'This person deactivated their own account; it cannot be changed here.'
              : 'You cannot change this account (it may be your own, or you may not have permission).'}
          </p>
        ) : null}
        {u.activeRide && u.canSuspend ? (
          <p style={{ margin: 0 }}>
            They are on a ride, so suspension will be refused until the ride is finished or
            cancelled.
          </p>
        ) : null}
      </section>

      <AuditTrail entries={u.audit} />
    </div>
  );
}
