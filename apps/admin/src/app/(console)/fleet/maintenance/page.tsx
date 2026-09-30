import Link from 'next/link';
import { SERVICE_STATUSES, SERVICE_STATUS_LABELS } from '@yatri/types';

import { listServiceRecordsApi } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { Pagination, withParams } from '../../ui/Pagination';
import { FleetNav, ServiceTable } from '../parts';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ status?: string; page?: string }>;
}

/** Inspections and maintenance across vehicles, the ones still in progress first. Open a vehicle to act on it. */
export default async function MaintenancePage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const status = (SERVICE_STATUSES as readonly string[]).includes(sp.status ?? '')
    ? sp.status
    : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const { data, denied } = await loadOrDenied(() =>
    listServiceRecordsApi(token, { status, page, pageSize: PAGE_SIZE }),
  );
  if (denied || !data) return <NoAccess what="maintenance records" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Maintenance and inspections</h1>
        <Link href="/fleet" style={styles.backLink}>
          ← Fleets
        </Link>
      </div>
      <FleetNav />
      <form method="get" style={styles.filterForm} role="search" aria-label="Filter records">
        <div style={styles.field}>
          <label htmlFor="status" style={styles.label}>
            Status
          </label>
          <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
            <option value="">Any</option>
            {SERVICE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SERVICE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" style={styles.buttonPrimary}>
          Apply filter
        </button>
      </form>
      <ServiceTable records={data.items} showVehicle />
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data.total}
        href={(p) => withParams('/fleet/maintenance', { status, page: String(p) })}
      />
    </div>
  );
}
