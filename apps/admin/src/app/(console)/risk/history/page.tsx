import Link from 'next/link';

import { getRiskHistory } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { Pagination, withParams } from '../../ui/Pagination';
import { RiskNav } from '../parts';

const PAGE_SIZE = 30;

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

const WHAT: Record<string, string> = {
  risk_user: 'Person',
  risk_trip: 'Ride',
  risk_rule: 'Rule',
};

/** Who did what in risk, and why, newest first (the one audit log). Notes are not copied here, only that one was added. */
export default async function RiskHistoryPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const { data, denied } = await loadOrDenied(() =>
    getRiskHistory(token, { page, pageSize: PAGE_SIZE }),
  );
  if (denied || !data) return <NoAccess what="the risk history" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Risk history</h1>
        <Link href="/risk" style={styles.backLink}>
          ← Overview
        </Link>
      </div>
      <RiskNav />
      {data.items.length === 0 ? (
        <p style={{ margin: 0 }}>Nothing has happened yet.</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
          {data.items.map((e) => (
            <li key={e.id}>
              {new Date(e.createdAt).toLocaleString()}: {WHAT[e.subjectType] ?? e.subjectType}{' '}
              {e.action.replaceAll('_', ' ').toLowerCase()} by{' '}
              {e.actorName ?? (e.actorRole ? e.actorRole.toLowerCase() : 'the system')}
              {typeof e.detail.reason === 'string' ? `. Reason: ${e.detail.reason}` : ''}
              {e.subjectType === 'risk_user' && e.subjectId ? (
                <>
                  {' '}
                  (<Link href={`/risk/users/${e.subjectId}`}>person</Link>)
                </>
              ) : null}
              {e.subjectType === 'risk_trip' && e.subjectId ? (
                <>
                  {' '}
                  (<Link href={`/risk/trips/${e.subjectId}`}>ride</Link>)
                </>
              ) : null}
              .
            </li>
          ))}
        </ol>
      )}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data.total}
        href={(p) => withParams('/risk/history', { page: String(p) })}
      />
    </div>
  );
}
