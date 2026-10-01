import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  RISK_CATEGORY_LABELS,
  RISK_EVENT_STATUS_LABELS,
  RISK_EVENT_TRANSITIONS,
  riskRuleDef,
} from '@yatri/types';

import { ApiError, getRiskEvent } from '../../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../../lib/session';
import { styles } from '../../../drivers/styles';
import { RiskNoteForm, ReviewForm } from '../../Forms';
import { RiskNav, describeEvidence } from '../../parts';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** One signal: what fired, the counts behind it, and the records to look at. The decision is made here. */
export default async function RiskEventPage({ params }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  let e;
  try {
    e = await getRiskEvent(token, id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const rule = riskRuleDef(e.ruleCode);
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{e.ruleLabel}</h1>
        <Link href="/risk/events" style={styles.backLink}>
          ← Signals
        </Link>
      </div>
      <RiskNav />

      <section aria-labelledby="what-h" style={styles.section}>
        <h2 id="what-h" style={styles.sectionTitle}>
          What happened
        </h2>
        <p style={{ margin: 0 }}>
          {RISK_CATEGORY_LABELS[e.category]}. {RISK_EVENT_STATUS_LABELS[e.status]}. {e.points}{' '}
          points. Raised {new Date(e.createdAt).toLocaleString()}.
        </p>
        {rule ? <p style={{ margin: 0 }}>{rule.help}</p> : null}
        <p style={{ margin: 0 }}>Evidence: {describeEvidence(e.evidence)}.</p>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {e.userId ? (
            <li>
              <Link href={`/risk/users/${e.userId}`}>Investigate {e.userName ?? 'the person'}</Link>
            </li>
          ) : null}
          {e.tripId ? (
            <li>
              <Link href={`/risk/trips/${e.tripId}`}>Investigate the ride</Link>
            </li>
          ) : null}
          {(e.evidence.tripIds ?? []).map((t) => (
            <li key={t}>
              <Link href={`/risk/trips/${t}`}>Related ride {t.slice(0, 8)}</Link>
            </li>
          ))}
          {(e.evidence.relatedUserIds ?? []).map((u) => (
            <li key={u}>
              <Link href={`/risk/users/${u}`}>Related person {u.slice(0, 8)}</Link>
            </li>
          ))}
        </ul>
        {e.reviewedAt ? (
          <p style={{ margin: 0 }}>
            Reviewed {new Date(e.reviewedAt).toLocaleString()}
            {e.reviewNote ? `. Reason: ${e.reviewNote}` : ''}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="dec-h" style={styles.section}>
        <h2 id="dec-h" style={styles.sectionTitle}>
          Decision
        </h2>
        <ReviewForm eventId={e.id} allowed={RISK_EVENT_TRANSITIONS[e.status]} />
      </section>

      <section aria-labelledby="note-h" style={styles.section}>
        <h2 id="note-h" style={styles.sectionTitle}>
          Add a note
        </h2>
        <RiskNoteForm eventId={e.id} />
      </section>
    </div>
  );
}
