import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SOS_STATUS_LABELS } from '@yatri/types';

import { ApiError, getAdminSos } from '../../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../../lib/session';
import { styles } from '../../../drivers/styles';
import { AuditTrail } from '../../AuditTrail';
import { SosActions } from '../../Forms';

interface PageProps {
  params: Promise<{ id: string }>;
}

const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const SOURCE_TEXT: Record<string, string> = {
  DEVICE: "the person's phone",
  DRIVER_FEED: "the driver's live location",
  NONE: 'none available',
};

/** One SOS alert. Opening it records that this admin looked at the position. */
export default async function SosDetailPage({ params }: PageProps) {
  const accessToken = await requireAdminAccessToken();
  const { id } = await params;
  let sos;
  try {
    sos = await getAdminSos(accessToken, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const rows: Array<[string, string]> = [
    ['Status', SOS_STATUS_LABELS[sos.status]],
    [
      'Raised by',
      `${sos.role === 'PASSENGER' ? 'Passenger' : 'Driver'} ${sos.userName ?? 'unnamed'}`,
    ],
    ['Raised at', at(sos.createdAt)],
    ['Emergency contacts told', String(sos.contactsNotified)],
    ['Passenger', sos.trip.passengerName ?? 'unnamed'],
    ['Driver', sos.trip.driverName ?? 'unnamed'],
    ['Vehicle', [sos.trip.vehicle, sos.trip.registration].filter(Boolean).join(', ') || '—'],
    ['Pickup', sos.trip.pickup],
    ['Destination', sos.trip.destination],
    ['Acknowledged', at(sos.acknowledgedAt)],
    ['Resolved', at(sos.resolvedAt)],
    ['Resolution', sos.resolutionNote ?? '—'],
  ];
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>SOS alert</h1>
        <Link href="/safety" style={styles.backLink}>
          ← Safety
        </Link>
      </div>

      <section aria-labelledby="loc-h" style={styles.section}>
        <h2 id="loc-h" style={styles.sectionTitle}>
          Location
        </h2>
        {sos.location ? (
          <>
            <p style={{ margin: 0, fontSize: 18 }}>
              {sos.location.latitude.toFixed(5)}, {sos.location.longitude.toFixed(5)}
              {sos.location.accuracyMeters !== null
                ? `, accurate to about ${Math.round(sos.location.accuracyMeters)} metres`
                : ''}
            </p>
            <p style={{ margin: 0 }}>
              Source: {SOURCE_TEXT[sos.location.source] ?? sos.location.source}. Recorded{' '}
              {at(sos.location.recordedAt)}.
            </p>
            <p style={{ margin: 0 }}>
              The position is shown as numbers, not sent to a map service. Read it to the emergency
              services if you call them.
            </p>
          </>
        ) : (
          <p style={{ margin: 0 }}>
            No position was available when the alert was raised. Use the ride to reach both people.
          </p>
        )}
      </section>

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
        <Link href={`/rides/${sos.tripId}`}>Open the ride</Link>
      </section>

      <section aria-labelledby="act-h" style={styles.section}>
        <h2 id="act-h" style={styles.sectionTitle}>
          Respond
        </h2>
        <SosActions sosId={sos.id} status={sos.status} />
      </section>

      <AuditTrail entries={sos.audit} />
    </div>
  );
}
