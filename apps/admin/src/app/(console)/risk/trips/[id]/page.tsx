import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, getRiskTrip } from '../../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../../lib/session';
import { styles } from '../../../drivers/styles';
import { AuditTrail } from '../../../safety/AuditTrail';
import { RiskNoteForm } from '../../Forms';
import { EventsTable, NotesList, RiskNav } from '../../parts';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** One ride, for an investigation: who was in it, the signals that point at it and the notes. The ride itself is on the rides page. */
export default async function RiskTripPage({ params }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  let t;
  try {
    t = await getRiskTrip(token, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Ride {t.tripId.slice(0, 8)}</h1>
        <Link href="/risk" style={styles.backLink}>
          ← Overview
        </Link>
      </div>
      <RiskNav />

      <section aria-labelledby="ride-h" style={styles.section}>
        <h2 id="ride-h" style={styles.sectionTitle}>
          The ride
        </h2>
        <p style={{ margin: 0 }}>
          Status {t.status.toLowerCase().replaceAll('_', ' ')}. Payment record:{' '}
          {t.hasPayment ? 'yes' : 'no'}. Refund request: {t.hasRefund ? 'yes' : 'no'}. Dispute:{' '}
          {t.hasDispute ? 'yes' : 'no'}.
        </p>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            Passenger:{' '}
            <Link href={`/risk/users/${t.passengerId}`}>{t.passengerName ?? 'Unnamed'}</Link>
          </li>
          <li>
            Driver:{' '}
            {t.driverId ? (
              <Link href={`/risk/users/${t.driverId}`}>{t.driverName ?? 'Unnamed'}</Link>
            ) : (
              'none'
            )}
          </li>
          <li>
            <Link href={`/rides/${t.tripId}`}>Open the ride, with its route and payment</Link>
          </li>
        </ul>
      </section>

      <section aria-labelledby="ev-h" style={styles.section}>
        <h2 id="ev-h" style={styles.sectionTitle}>
          Signals that point at this ride
        </h2>
        <EventsTable events={t.events} label="Risk signals for this ride" />
      </section>

      <section aria-labelledby="notes-h" style={styles.section}>
        <h2 id="notes-h" style={styles.sectionTitle}>
          Internal notes
        </h2>
        <NotesList notes={t.notes} />
        <RiskNoteForm tripId={t.tripId} />
      </section>

      <AuditTrail entries={t.audit} />
    </div>
  );
}
