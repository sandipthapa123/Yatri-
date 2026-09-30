import Link from 'next/link';
import { EXPIRY_KINDS, EXPIRY_KIND_LABELS, EXPIRY_STATES, EXPIRY_STATE_LABELS } from '@yatri/types';

import { getFleetOptions, listExpiring } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { CheckNowButton } from '../Forms';
import { ExpiryTable, FleetNav } from '../parts';

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

/**
 * Everything that is expiring, expired or missing, from the document system and the dates already on file:
 * driver and vehicle documents, licences, registrations, insurance and service dates. Worst first. Drivers
 * are reminded automatically; an expired required paper stops the driver being offered rides.
 */
export default async function ExpiringPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const state = (EXPIRY_STATES as readonly string[]).includes(sp.state ?? '')
    ? sp.state
    : undefined;
  const kind = (EXPIRY_KINDS as readonly string[]).includes(sp.kind ?? '') ? sp.kind : undefined;
  const { data, denied } = await loadOrDenied(async () => ({
    items: await listExpiring(token, { state, kind, fleetId: sp.fleetId || undefined }),
    options: await getFleetOptions(token),
  }));
  if (denied || !data) return <NoAccess what="expiring documents" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Expiring documents and dates</h1>
        <Link href="/fleet" style={styles.backLink}>
          ← Fleets
        </Link>
      </div>
      <FleetNav />
      <form method="get" style={styles.filterForm} role="search" aria-label="Filter expiring items">
        <div style={styles.field}>
          <label htmlFor="state" style={styles.label}>
            State
          </label>
          <select id="state" name="state" defaultValue={state ?? ''} style={styles.select}>
            <option value="">Needs attention</option>
            {EXPIRY_STATES.map((s) => (
              <option key={s} value={s}>
                {EXPIRY_STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="kind" style={styles.label}>
            Kind
          </label>
          <select id="kind" name="kind" defaultValue={kind ?? ''} style={styles.select}>
            <option value="">Any</option>
            {EXPIRY_KINDS.map((k) => (
              <option key={k} value={k}>
                {EXPIRY_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="fleetId" style={styles.label}>
            Fleet
          </label>
          <select id="fleetId" name="fleetId" defaultValue={sp.fleetId ?? ''} style={styles.select}>
            <option value="">Any</option>
            {data.options.fleets.map((f) => (
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
      <p style={{ margin: 0 }}>
        {data.items.length} item{data.items.length === 1 ? '' : 's'}.
      </p>
      <ExpiryTable items={data.items} label="Expiring, expired and missing documents and dates" />
      <CheckNowButton />
    </div>
  );
}
