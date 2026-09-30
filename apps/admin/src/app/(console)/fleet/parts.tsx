import Link from 'next/link';
import {
  EXPIRY_KIND_LABELS,
  EXPIRY_STATE_LABELS,
  SERVICE_KIND_LABELS,
  SERVICE_STATUS_LABELS,
  type ExpiryItem,
  type ServiceRecordInfo,
} from '@yatri/types';

import { styles } from '../drivers/styles';

/** Section links shared by every fleet page. */
export function FleetNav() {
  return (
    <nav aria-label="Fleet sections" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <Link href="/fleet">Fleets</Link>
      <Link href="/fleet/drivers">Drivers</Link>
      <Link href="/fleet/vehicles">Vehicles</Link>
      <Link href="/fleet/expiring">Expiring documents</Link>
      <Link href="/fleet/maintenance">Maintenance</Link>
      <Link href="/fleet/drivers?operational=SUSPENDED">Suspensions</Link>
      <Link href="/fleet/history">Operational history</Link>
    </nav>
  );
}

const caption = { textAlign: 'left', position: 'absolute', left: -9999 } as const;

/**
 * What needs attention (or everything, for one vehicle or driver). The state is a word in its own column
 * ("Expired", "Expiring soon", "Missing", "Valid") beside the date and the days left, so nothing depends on colour.
 */
export function ExpiryTable({ items, label }: { items: ExpiryItem[]; label: string }) {
  if (items.length === 0) return <p style={{ margin: 0 }}>Nothing is expiring or missing.</p>;
  return (
    <table style={styles.table}>
      <caption style={caption}>{label}</caption>
      <thead>
        <tr>
          {['State', 'What', 'Kind', 'Whose', 'Date', 'Days left'].map((h) => (
            <th key={h} scope="col" style={styles.th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={`${i.kind}:${i.vehicleId ?? ''}:${i.driverId ?? ''}:${i.itemKey}`}>
            <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
              {EXPIRY_STATE_LABELS[i.state]}
            </th>
            <td style={styles.td}>{i.label}</td>
            <td style={styles.td}>{EXPIRY_KIND_LABELS[i.kind]}</td>
            <td style={styles.td}>
              {i.vehicleId ? (
                <Link href={`/fleet/vehicles/${i.vehicleId}`}>Vehicle {i.vehicleRegistration}</Link>
              ) : i.driverId ? (
                <Link href={`/fleet/drivers/${i.driverId}`}>{i.driverName ?? 'Driver'}</Link>
              ) : (
                '—'
              )}
              {i.fleetName ? ` (${i.fleetName})` : ''}
            </td>
            <td style={styles.td}>{i.expiresOn ? i.expiresOn.slice(0, 10) : 'No date'}</td>
            <td style={styles.td}>
              {i.daysLeft === null ? '—' : i.daysLeft < 0 ? `${-i.daysLeft} days ago` : i.daysLeft}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ServiceTable({
  records,
  showVehicle,
}: {
  records: ServiceRecordInfo[];
  showVehicle?: boolean;
}) {
  if (records.length === 0)
    return <p style={{ margin: 0 }}>No inspections or maintenance recorded.</p>;
  return (
    <table style={styles.table}>
      <caption style={caption}>Inspections and maintenance</caption>
      <thead>
        <tr>
          {[
            ...(showVehicle ? ['Vehicle'] : []),
            'Status',
            'Kind',
            'Done on',
            'Next due',
            'Result',
            'Notes',
            'Recorded by',
          ].map((h) => (
            <th key={h} scope="col" style={styles.th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <tr key={r.id}>
            {showVehicle ? (
              <td style={styles.td}>
                <Link href={`/fleet/vehicles/${r.vehicleId}`}>{r.vehicleRegistration}</Link>
              </td>
            ) : null}
            <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
              {SERVICE_STATUS_LABELS[r.status]}
            </th>
            <td style={styles.td}>{SERVICE_KIND_LABELS[r.kind]}</td>
            <td style={styles.td}>{r.performedOn ?? '—'}</td>
            <td style={styles.td}>{r.nextDueOn ?? '—'}</td>
            <td style={styles.td}>
              {r.result ? (r.result === 'PASSED' ? 'Passed' : 'Failed') : '—'}
            </td>
            <td style={styles.td}>{r.notes ?? ''}</td>
            <td style={styles.td}>{r.recordedByName ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
