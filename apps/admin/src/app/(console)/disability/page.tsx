import {
  DISABILITY_METHODS,
  DISABILITY_METHOD_LABELS,
  DISABILITY_STATUS_LABELS,
  DISABILITY_VERIFICATION_STATUSES,
  maskedCard,
  type DisabilityMethod,
  type DisabilityVerificationStatus,
} from '@yatri/types';
import Link from 'next/link';

import { loadOrDenied } from '../../../lib/access';
import { listDisabilityApi } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'not yet');
const PAGE = 25;

/**
 * Disability benefit verification: the applications waiting for a person and the decisions already made. The card number
 * is never on this screen (only its last four characters). Filters and paging are links, so they work with a keyboard and
 * without a script. A card that is also on another account is marked in words, as a reason to look and never a verdict.
 */
export default async function DisabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; method?: string; duplicate?: string; offset?: string }>;
}) {
  const q = await searchParams;
  const status = (DISABILITY_VERIFICATION_STATUSES as readonly string[]).includes(q.status ?? '') ? (q.status as DisabilityVerificationStatus) : undefined;
  const method = (DISABILITY_METHODS as readonly string[]).includes(q.method ?? '') ? (q.method as DisabilityMethod) : undefined;
  const duplicate = q.duplicate === 'true' ? true : undefined;
  const offset = Math.max(0, Number(q.offset) || 0);
  const token = await requireAdminAccessToken();
  const { data, denied } = await loadOrDenied(() => listDisabilityApi(token, { status, method, duplicate, limit: PAGE, offset }));
  if (denied || !data) return <NoAccess what="disability benefit verification" />;
  const link = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { status, method, duplicate: duplicate ? 'true' : undefined, offset: undefined, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    const s = p.toString();
    return `/disability${s ? `?${s}` : ''}`;
  };
  const waiting = data.items.filter((i) => i.status === 'SUBMITTED' || i.status === 'UNDER_REVIEW').length;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Disability benefit verification</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        Riders who chose to apply for disability benefits. Open a case to see the card details, the document and the history,
        and to decide. Every decision is recorded and the rider is told.
      </p>
      <p role="status" style={{ margin: 0, fontWeight: 600 }}>
        {data.total} {data.total === 1 ? 'application' : 'applications'} match. {waiting} on this page {waiting === 1 ? 'is' : 'are'} waiting for a person.
      </p>
      <nav aria-label="Filter applications" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <strong>Status:</strong>
        <Link href={link({ status: undefined })} aria-current={!status ? 'true' : undefined}>All</Link>
        {DISABILITY_VERIFICATION_STATUSES.filter((s) => s !== 'NOT_SUBMITTED').map((s) => (
          <Link key={s} href={link({ status: s })} aria-current={status === s ? 'true' : undefined}>
            {DISABILITY_STATUS_LABELS[s]}
          </Link>
        ))}
        <strong>How it is checked:</strong>
        <Link href={link({ method: undefined })} aria-current={!method ? 'true' : undefined}>Any</Link>
        {DISABILITY_METHODS.map((m) => (
          <Link key={m} href={link({ method: m })} aria-current={method === m ? 'true' : undefined}>
            {DISABILITY_METHOD_LABELS[m].label}
          </Link>
        ))}
        <Link href={link({ duplicate: duplicate ? undefined : 'true' })} aria-current={duplicate ? 'true' : undefined}>
          {duplicate ? 'Showing: card on other accounts too (show all)' : 'Only cards on other accounts too'}
        </Link>
      </nav>
      {data.items.length === 0 ? (
        <p>No applications match.</p>
      ) : (
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>Disability benefit applications</caption>
          <thead>
            <tr>
              {['Rider', 'State', 'Checked by', 'Card', 'Issued by', 'Expires', 'Sent', 'Flags'].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.id}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  <Link href={`/disability/${i.id}`}>{i.userName ?? 'Unnamed rider'}</Link>
                </th>
                <td style={styles.td}>{i.statusLabel}</td>
                <td style={styles.td}>
                  {i.verifiedMethod ? `Verified by: ${DISABILITY_METHOD_LABELS[i.verifiedMethod].label}` : `Chosen: ${DISABILITY_METHOD_LABELS[i.method].label}`}
                </td>
                <td style={styles.td}>{maskedCard(i.cardLast4)}</td>
                <td style={styles.td}>{i.issuingAuthority ?? 'not given'}</td>
                <td style={styles.td}>{i.expiryDate ?? 'not given'}</td>
                <td style={styles.td}>{when(i.submittedAt)}</td>
                <td style={styles.td}>
                  {i.duplicateCount > 0 ? `Card number is also on ${i.duplicateCount} other ${i.duplicateCount === 1 ? 'account' : 'accounts'}. ` : ''}
                  {i.hasDocument ? 'Has a document.' : 'No document.'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <nav aria-label="Pages" style={{ display: 'flex', gap: 12 }}>
        {offset > 0 ? <Link href={link({ offset: String(Math.max(0, offset - PAGE)) })}>Previous page</Link> : null}
        {offset + PAGE < data.total ? <Link href={link({ offset: String(offset + PAGE) })}>Next page</Link> : null}
      </nav>
    </div>
  );
}
