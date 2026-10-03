import {
  DISABILITY_ADMIN_ACTION_LABELS,
  DISABILITY_METHOD_LABELS,
  maskedCard,
  formatWhen,
} from '@yatri/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { loadOrDenied } from '../../../../lib/access';
import { ApiError, getDisabilityApi } from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { DecisionForm, OpenDocumentForm } from '../Forms';

const when = (iso: string | null) => formatWhen(iso, { empty: 'not yet' });

/**
 * One application: what the rider submitted (never the full card number), how it is being checked, the document, the
 * other accounts holding the same number, the full history, and the decisions allowed from the current state. The buttons
 * come from the server's list of allowed actions, so a decision that is not legal is simply not offered.
 */
export default async function DisabilityCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await requireAdminAccessToken();
  const found = await loadOrDenied(() => getDisabilityApi(token, id)).catch((e) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  if (found.denied || !found.data) return <NoAccess what="this application" />;
  const d = found.data;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{d.userName ?? 'Unnamed rider'}: disability benefit</h1>
        <Link href="/disability" style={styles.backLink}>
          ← Applications
        </Link>
      </div>

      <section aria-labelledby="summary-h" style={styles.section}>
        <h2 id="summary-h" style={styles.sectionTitle}>
          The application
        </h2>
        <ul>
          <li>State: {d.statusLabel}</li>
          <li>
            {d.verifiedMethod
              ? `Verified by: ${DISABILITY_METHOD_LABELS[d.verifiedMethod].label}`
              : `Chosen way of checking: ${DISABILITY_METHOD_LABELS[d.method].label}`}
          </li>
          <li>Card number: {maskedCard(d.cardLast4)}</li>
          <li>Issued by: {d.issuingAuthority ?? 'not given'}</li>
          <li>Issue date: {d.issueDate ?? 'not given'}</li>
          <li>Expiry date: {d.expiryDate ?? 'not given'}</li>
          <li>Consent to use the card details: {d.consentActive ? `given ${when(d.consentGivenAt)}` : 'not in force (withdrawn or never given)'}</li>
          <li>Sent: {when(d.submittedAt)}</li>
          {d.verifiedAt ? <li>Verified: {when(d.verifiedAt)}, valid until {d.validUntil ?? 'not set'}</li> : null}
          {d.message ? <li>Latest message to the rider: {d.message}</li> : null}
        </ul>
      </section>

      {d.duplicateCount > 0 ? (
        <section aria-labelledby="dup-h" style={styles.section}>
          <h2 id="dup-h" style={styles.sectionTitle}>
            Same card number on other accounts
          </h2>
          <p>
            This card number is also on {d.duplicateCount} other {d.duplicateCount === 1 ? 'account' : 'accounts'}. That is a
            reason to look, not proof of anything: a family may share an address, and a number can be mistyped.
          </p>
          <ul>
            {d.duplicates.map((x) => (
              <li key={x.verificationId}>
                <Link href={`/disability/${x.verificationId}`}>Another application</Link>, state: {x.status.toLowerCase().replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="doc-h" style={styles.section}>
        <h2 id="doc-h" style={styles.sectionTitle}>
          The document
        </h2>
        {d.document ? (
          <>
            <p>
              {d.document.name} ({d.document.mimeType}, {Math.max(1, Math.round(d.document.sizeBytes / 1024))} KB), added {when(d.document.uploadedAt)}.
            </p>
            <OpenDocumentForm id={d.id} name={d.document.name} />
          </>
        ) : (
          <p>No document was added{d.method === 'OFFICIAL_API' ? ' (the official check does not need one)' : ''}.</p>
        )}
      </section>

      <section aria-labelledby="act-h" style={styles.section}>
        <h2 id="act-h" style={styles.sectionTitle}>
          Decisions
        </h2>
        {d.allowedActions.length === 0 ? (
          <p>No decision can be made from this state.</p>
        ) : (
          d.allowedActions.map((a) => (
            <details key={a} style={{ marginBottom: 8 }}>
              <summary>{DISABILITY_ADMIN_ACTION_LABELS[a].label}</summary>
              <DecisionForm detail={d} action={a} />
            </details>
          ))
        )}
      </section>

      <section aria-labelledby="hist-h" style={styles.section}>
        <h2 id="hist-h" style={styles.sectionTitle}>
          History
        </h2>
        <ol>
          {d.history.map((h) => (
            <li key={h.id}>
              {when(h.at)}: {h.fromStatus.toLowerCase().replace(/_/g, ' ')} to {h.toLabel.toLowerCase()}, by{' '}
              {h.actorKind === 'ADMIN' ? (h.actorName ?? 'an administrator') : h.actorKind === 'SYSTEM' ? 'the system' : 'the rider'}
              {h.method ? ` (${DISABILITY_METHOD_LABELS[h.method].label})` : ''}
              {h.note ? `. ${h.note}` : ''}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
