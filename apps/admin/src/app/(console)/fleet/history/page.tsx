import { formatWhen } from '@yatri/types';
import Link from 'next/link';

import { getFleetHistory } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { Pagination, withParams } from '../../ui/Pagination';
import { FleetNav } from '../parts';

const PAGE_SIZE = 30;

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

const WHAT: Record<string, string> = {
  fleet: 'Fleet',
  vehicle: 'Vehicle',
  driver_operations: 'Driver',
  vehicle_service: 'Maintenance',
};

/** Who changed what and why across fleets, vehicles, assignments, drivers and maintenance, newest first (the one audit log). */
export default async function HistoryPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const { data, denied } = await loadOrDenied(() =>
    getFleetHistory(token, { page, pageSize: PAGE_SIZE }),
  );
  if (denied || !data) return <NoAccess what="the operational history" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Operational history</h1>
        <Link href="/fleet" style={styles.backLink}>
          ← Fleets
        </Link>
      </div>
      <FleetNav />
      {data.items.length === 0 ? (
        <p style={{ margin: 0 }}>Nothing has happened yet.</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
          {data.items.map((e) => (
            <li key={e.id}>
              {formatWhen(e.createdAt)}: {WHAT[e.subjectType] ?? e.subjectType}{' '}
              {e.action.replaceAll('_', ' ').toLowerCase()} by{' '}
              {e.actorName ?? (e.actorRole ? e.actorRole.toLowerCase() : 'the system')}
              {typeof e.detail.reason === 'string' ? `. Reason: ${e.detail.reason}` : ''}
              {typeof e.detail.from === 'string' && typeof e.detail.to === 'string'
                ? `. From ${e.detail.from.toLowerCase()} to ${e.detail.to.toLowerCase()}`
                : ''}
              .
            </li>
          ))}
        </ol>
      )}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data.total}
        href={(p) => withParams('/fleet/history', { page: String(p) })}
      />
    </div>
  );
}
