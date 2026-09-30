import Link from 'next/link';
import { OPERATIONAL_LABELS, OPERATIONAL_STATES } from '@yatri/types';

import { getFleetOptions, listFleetDriversApi } from '../../../../lib/apiClient';
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

/**
 * Drivers as operations sees them. Four separate statuses sit in four columns, each from its own model
 * (account, verification, operational, availability), so none is mistaken for another; the last column says
 * whether the driver can be offered rides right now. Filter by operational status to see suspensions.
 */
export default async function FleetDriversPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const operational = (OPERATIONAL_STATES as readonly string[]).includes(sp.operational ?? '')
    ? sp.operational
    : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const params = {
    fleetId: sp.fleetId || undefined,
    operational,
    search: sp.search?.trim() || undefined,
  };
  const { data, denied } = await loadOrDenied(async () => ({
    list: await listFleetDriversApi(token, { ...params, page, pageSize: PAGE_SIZE }),
    options: await getFleetOptions(token),
  }));
  if (denied || !data) return <NoAccess what="drivers" />;
  const { list, options } = data;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>
          {operational === 'SUSPENDED' ? 'Suspended drivers' : 'Drivers'}
        </h1>
        <Link href="/fleet" style={styles.backLink}>
          ← Fleets
        </Link>
      </div>
      <FleetNav />
      <form method="get" style={styles.filterForm} role="search" aria-label="Filter drivers">
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Search (name or phone)
          </label>
          <input
            id="search"
            name="search"
            defaultValue={params.search ?? ''}
            style={styles.input}
          />
        </div>
        <div style={styles.field}>
          <label htmlFor="operational" style={styles.label}>
            Operational status
          </label>
          <select
            id="operational"
            name="operational"
            defaultValue={operational ?? ''}
            style={styles.select}
          >
            <option value="">Any</option>
            {OPERATIONAL_STATES.map((s) => (
              <option key={s} value={s}>
                {OPERATIONAL_LABELS[s]}
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
        <button type="submit" style={styles.buttonPrimary}>
          Apply filters
        </button>
      </form>
      {list.items.length === 0 ? (
        <p style={styles.emptyState}>No drivers match.</p>
      ) : (
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
            Drivers
          </caption>
          <thead>
            <tr>
              {[
                'Driver',
                'Account',
                'Verification',
                'Operational',
                'Availability',
                'Fleet',
                'Vehicles',
                'Can take rides',
              ].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.items.map((d) => (
              <tr key={d.id}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  <Link href={`/fleet/drivers/${d.id}`}>{d.name ?? 'Unnamed driver'}</Link>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    {d.phone ?? ''}
                  </div>
                </th>
                <td style={styles.td}>{d.accountStatus.toLowerCase()}</td>
                <td style={styles.td}>{d.verificationStatus.toLowerCase().replace(/_/g, ' ')}</td>
                <td style={styles.td}>{OPERATIONAL_LABELS[d.operationalStatus]}</td>
                <td style={styles.td}>{d.availability.toLowerCase().replace(/_/g, ' ')}</td>
                <td style={styles.td}>{d.fleetName ?? 'None'}</td>
                <td style={styles.td}>{d.vehicleCount}</td>
                <td style={styles.td}>{d.eligible ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={list.total}
        href={(p) => withParams('/fleet/drivers', { ...params, page: String(p) })}
      />
    </div>
  );
}
