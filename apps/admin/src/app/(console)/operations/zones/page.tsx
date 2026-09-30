import Link from 'next/link';
import { ZONE_KIND_LABELS } from '@yatri/types';

import { listZones } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { ZoneForm } from '../Forms';

/** Service zones: where rides may start and end, and the named places pricing and bonuses refer to. */
export default async function ZonesPage() {
  const token = await requireAdminAccessToken();
  const { data: zones, denied } = await loadOrDenied(() => listZones(token));
  if (denied || !zones) return <NoAccess what="service zones" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Service zones</h1>
        <Link href="/operations" style={styles.backLink}>
          ← Demand, zones and pricing
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        While at least one service area or city boundary is in use, rides must start and end inside
        one. Restricted, airport and venue zones can forbid starting or ending a ride in them and
        can carry a note riders read before confirming. A zone is switched off, never deleted, so
        the rules that refer to it keep working.
      </p>
      {zones.length === 0 ? (
        <p style={{ margin: 0 }}>No zones yet: rides are allowed everywhere.</p>
      ) : null}
      {zones.map((z) => (
        <section key={z.id} aria-label={z.name} style={styles.section}>
          <p style={{ margin: 0 }}>
            <strong>{z.name}</strong> ({z.code}) · {ZONE_KIND_LABELS[z.kind]} ·{' '}
            {z.isActive ? 'in use' : 'not in use'} · {z.polygon.length} corners · rides may{' '}
            {z.pickupAllowed ? '' : 'not '}start here and may {z.dropoffAllowed ? '' : 'not '}end
            here · priority {z.priority}
            {z.note ? ` · note: ${z.note}` : ''}
          </p>
          <ZoneForm zone={z} />
        </section>
      ))}
      <section aria-labelledby="new-h" style={styles.section}>
        <h2 id="new-h" style={styles.sectionTitle}>
          Add a zone
        </h2>
        <ZoneForm />
      </section>
    </div>
  );
}
