import Link from 'next/link';
import { notFound } from 'next/navigation';
import { INCIDENT_CATEGORY_LABELS, INCIDENT_STATUS_LABELS } from '@yatri/types';

import { ApiError, getAdminIncident } from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../../drivers/styles';
import { AuditTrail } from '../../AuditTrail';
import { IncidentNoteForm, IncidentStatusForm } from '../../Forms';

interface PageProps {
  params: Promise<{ id: string }>;
}

const at = (iso: string) => new Date(iso).toLocaleString();
const KIND_TEXT = { NOTE: 'Note', ACTION: 'Action taken', STATUS: 'Status change' } as const;

/** One incident report: what was said, the review history and internal notes, and the controls. */
export default async function IncidentDetailPage({ params }: PageProps) {
  const accessToken = await requireAdminAccessToken();
  const { id } = await params;
  let incident;
  try {
    incident = await getAdminIncident(accessToken, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  return (
    <main style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{INCIDENT_CATEGORY_LABELS[incident.category]} report</h1>
        <Link href="/safety" style={styles.backLink}>
          ← Safety
        </Link>
      </div>

      <section aria-labelledby="rep-h" style={styles.section}>
        <h2 id="rep-h" style={styles.sectionTitle}>
          The report
        </h2>
        <p style={{ margin: 0 }}>
          <strong>{INCIDENT_STATUS_LABELS[incident.status]}.</strong>{' '}
          {incident.reporterRole === 'PASSENGER' ? 'Passenger' : 'Driver'}{' '}
          {incident.reporterName ?? 'unnamed'} reported on {at(incident.createdAt)}:
        </p>
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{incident.description}</p>
        <Link href={`/rides/${incident.tripId}`}>Open the ride</Link>
      </section>

      <section aria-labelledby="st-h" style={styles.section}>
        <h2 id="st-h" style={styles.sectionTitle}>
          Change status
        </h2>
        <IncidentStatusForm incidentId={incident.id} status={incident.status} />
      </section>

      <section aria-labelledby="nt-h" style={styles.section}>
        <h2 id="nt-h" style={styles.sectionTitle}>
          Internal notes and actions
        </h2>
        {incident.notes.length === 0 ? (
          <p style={{ margin: 0 }}>Nothing recorded yet.</p>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
            {incident.notes.map((n) => (
              <li key={n.id}>
                <strong>{KIND_TEXT[n.kind]}</strong>
                {n.toStatus
                  ? `: ${n.fromStatus ? INCIDENT_STATUS_LABELS[n.fromStatus] : ''} to ${INCIDENT_STATUS_LABELS[n.toStatus]}`
                  : ''}{' '}
                ({n.adminName ?? 'an admin'}, {at(n.createdAt)}){n.body ? `: ${n.body}` : ''}
              </li>
            ))}
          </ol>
        )}
        <IncidentNoteForm incidentId={incident.id} />
      </section>

      <AuditTrail entries={incident.audit} />
    </main>
  );
}
