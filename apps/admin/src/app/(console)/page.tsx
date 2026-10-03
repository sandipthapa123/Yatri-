import Link from 'next/link';
import {
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUSES,
  TRIP_STATUS_LABELS,
  type TripStatus,
  formatWhen,
} from '@yatri/types';

import { getDashboard } from '../../lib/apiClient';
import { loadOrDenied } from '../../lib/access';
import { requireAdminAccessToken } from '../../lib/session';
import { styles } from './drivers/styles';
import { AutoRefresh } from './rides/AutoRefresh';
import { NoAccess } from './ui/NoAccess';
import { RangeFilter, rangeParamsOf } from './ui/RangeFilter';
import { withParams } from './ui/Pagination';

interface PageProps {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}

/**
 * One figure: the label (a link to the list behind it when there is one) and the number as its
 * definition, so a screen reader hears "Active rides now, 3". Valid dl/dt/dd, no link around both.
 */
function Stat(props: { label: string; value: number; href?: string; note?: string }) {
  return (
    <div
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        padding: 12,
        minWidth: 170,
      }}
    >
      <dt style={styles.dt}>
        {props.href ? <Link href={props.href}>{props.label}</Link> : props.label}
      </dt>
      <dd style={{ ...styles.dd, fontSize: 28, fontWeight: 800 }}>{props.value}</dd>
      {props.note ? (
        <dd style={{ ...styles.dd, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          {props.note}
        </dd>
      ) : null}
    </div>
  );
}

const grid = { display: 'flex', flexWrap: 'wrap', gap: 12, margin: 0 } as const;

/**
 * The live operational dashboard. Every number is counted by the API from the authoritative
 * tables when the page loads (and each refresh); "right now" figures ignore the period, the rest
 * follow it. Each figure that has a list behind it links to that list.
 */
export default async function DashboardPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const { data, denied } = await loadOrDenied(() => getDashboard(token, rangeParamsOf(sp)));
  if (denied) {
    return (
      <div style={styles.page}>
        <h1 style={styles.title}>Welcome</h1>
        <p style={{ margin: 0 }}>
          Your account can open the pages in the menu above. The live dashboard needs the live
          operations permission.
        </p>
      </div>
    );
  }
  if (!data) return <NoAccess what="the dashboard" />;
  const period = { range: sp.range, from: sp.from, to: sp.to };
  const inPeriod = (path: string, extra: Record<string, string>) =>
    withParams(path, {
      ...extra,
      ...(sp.from && sp.to ? { from: sp.from, to: sp.to } : { range: sp.range }),
    });

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Live operations</h1>
        <AutoRefresh seconds={15} />
      </div>
      <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
        Counted from the live records at {formatWhen(data.generatedAt, { style: 'time' })}. Driver
        figures use each driver&apos;s last saved location.
      </p>
      <RangeFilter {...period} defaultPreset="today" resolved={data.range} />

      <section aria-labelledby="rides-h" style={styles.section}>
        <h2 id="rides-h" style={styles.sectionTitle}>
          Rides
        </h2>
        <dl style={grid}>
          <Stat
            label="Active rides now"
            value={data.rides.active}
            href="/rides?group=active"
            note={
              Object.entries(data.rides.activeByStatus)
                .map(([s, n]) => `${n} ${TRIP_STATUS_LABELS[s as TripStatus].toLowerCase()}`)
                .join(', ') || 'None'
            }
          />
          <Stat
            label="Completed in this period"
            value={data.rides.completed}
            href={inPeriod('/rides', { status: 'COMPLETED' })}
          />
          <Stat
            label="Cancelled in this period"
            value={data.rides.cancelled}
            href={inPeriod('/rides', { status: 'CANCELLED' })}
          />
          <Stat
            label="No driver found in this period"
            value={data.rides.noDrivers}
            href={inPeriod('/rides', { status: 'NO_DRIVERS' })}
          />
        </dl>
      </section>

      <section aria-labelledby="drivers-h" style={styles.section}>
        <h2 id="drivers-h" style={styles.sectionTitle}>
          Drivers
        </h2>
        <dl style={grid}>
          <Stat label="Online" value={data.drivers.online} href="/availability?state=ONLINE" />
          <Stat
            label="Available for a ride"
            value={data.drivers.available}
            note="Verified, fresh location, not on a ride"
          />
          <Stat label="Online and on a ride" value={data.drivers.onTrip} />
          <Stat
            label="Online with a stale location"
            value={data.drivers.staleLocation}
            href="/availability?state=ONLINE&freshness=stale"
          />
          <Stat
            label="Applications awaiting review"
            value={data.drivers.pendingVerification}
            href="/drivers?status=SUBMITTED"
          />
        </dl>
      </section>

      <section aria-labelledby="pay-h" style={styles.section}>
        <h2 id="pay-h" style={styles.sectionTitle}>
          Payments in this period
        </h2>
        <dl style={grid}>
          {PAYMENT_STATUSES.map((s) => (
            <Stat
              key={s}
              label={PAYMENT_STATUS_LABELS[s]}
              value={data.payments[s]}
              href={inPeriod('/payments', { status: s })}
            />
          ))}
        </dl>
      </section>

      <section aria-labelledby="safety-h" style={styles.section}>
        <h2 id="safety-h" style={styles.sectionTitle}>
          Needing attention now
        </h2>
        <dl style={grid}>
          <Stat label="Active SOS alerts" value={data.safety.activeSos} href="/safety" />
          <Stat label="Open safety incidents" value={data.safety.openIncidents} href="/safety" />
          <Stat
            label="Open disputes"
            value={data.safety.openDisputes}
            href="/support?kind=dispute&group=open"
          />
        </dl>
      </section>
    </div>
  );
}
