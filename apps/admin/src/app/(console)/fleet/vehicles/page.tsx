import Link from 'next/link';
import { VEHICLE_LIFECYCLE_LABELS, VEHICLE_LIFECYCLE_STATES } from '@yatri/types';

import { getFleetOptions, listFleetVehiclesApi } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { Pagination, withParams } from '../../ui/Pagination';
import { FleetNav } from '../parts';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

/** Vehicles across fleets and drivers, each with its lifecycle status and whether it can be used for rides, in words. */
export default async function FleetVehiclesPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const lifecycle = (VEHICLE_LIFECYCLE_STATES as readonly string[]).includes(sp.lifecycle ?? '')
    ? sp.lifecycle
    : undefined;
  const assigned = sp.assigned === 'yes' || sp.assigned === 'no' ? sp.assigned : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const params = {
    fleetId: sp.fleetId || undefined,
    lifecycle,
    assigned,
    search: sp.search?.trim() || undefined,
  };
  const { data, denied } = await loadOrDenied(async () => ({
    list: await listFleetVehiclesApi(token, { ...params, page, pageSize: PAGE_SIZE }),
    options: await getFleetOptions(token),
  }));
  if (denied || !data) return <NoAccess what="vehicles" />;
  const { list, options } = data;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Vehicles</h1>
        <Link href="/fleet" style={styles.backLink}>
          ← Fleets
        </Link>
      </div>
      <FleetNav />
      <form method="get" style={styles.filterForm} role="search" aria-label="Filter vehicles">
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Search (registration, make, model or driver)
          </label>
          <input
            id="search"
            name="search"
            defaultValue={params.search ?? ''}
            style={styles.input}
          />
        </div>
        <div style={styles.field}>
          <label htmlFor="lifecycle" style={styles.label}>
            Status
          </label>
          <select
            id="lifecycle"
            name="lifecycle"
            defaultValue={lifecycle ?? ''}
            style={styles.select}
          >
            <option value="">Any</option>
            {VEHICLE_LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>
                {VEHICLE_LIFECYCLE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="fleetId" style={styles.label}>
            Fleet
          </label>
          <select
            id="fleetId"
            name="fleetId"
            defaultValue={params.fleetId ?? ''}
            style={styles.select}
          >
            <option value="">Any</option>
            {options.fleets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="assigned" style={styles.label}>
            Driver
          </label>
          <select id="assigned" name="assigned" defaultValue={assigned ?? ''} style={styles.select}>
            <option value="">Any</option>
            <option value="yes">Assigned</option>
            <option value="no">Not assigned</option>
          </select>
        </div>
        <button type="submit" style={styles.buttonPrimary}>
          Apply filters
        </button>
      </form>
      {list.items.length === 0 ? (
        <p style={styles.emptyState}>No vehicles match.</p>
      ) : (
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
            Vehicles
          </caption>
          <thead>
            <tr>
              {['Vehicle', 'Status', 'Review', 'Fleet', 'Driver', 'Can be used for rides'].map(
                (h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {list.items.map((v) => (
              <tr key={v.id}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  <Link href={`/fleet/vehicles/${v.id}`}>{v.registrationNumber}</Link>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    {v.description}
                    {v.categoryLabel ? `, ${v.categoryLabel}` : ''}
                  </div>
                </th>
                <td style={styles.td}>{VEHICLE_LIFECYCLE_LABELS[v.lifecycle]}</td>
                <td style={styles.td}>{v.verificationStatus.toLowerCase()}</td>
                <td style={styles.td}>{v.fleetName ?? 'None'}</td>
                <td style={styles.td}>{v.driverName ?? 'Not assigned'}</td>
                <td style={styles.td}>{v.eligible ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={list.total}
        href={(p) => withParams('/fleet/vehicles', { ...params, page: String(p) })}
      />
    </div>
  );
}
