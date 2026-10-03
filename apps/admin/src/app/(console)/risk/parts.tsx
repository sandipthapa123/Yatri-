import Link from 'next/link';
import {
  RISK_CATEGORY_LABELS,
  RISK_EVENT_STATUS_LABELS,
  RISK_LEVEL_LABELS,
  type RiskEventInfo,
  type RiskEvidence,
  type RiskLevel,
  type RiskNoteInfo,
  formatWhen,
} from '@yatri/types';

import { styles } from '../drivers/styles';

/** Section links shared by every risk page. */
export function RiskNav() {
  return (
    <nav aria-label="Risk sections" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <Link href="/risk">Overview</Link>
      <Link href="/risk/events">Signals</Link>
      <Link href="/risk/events?status=OPEN">Open signals</Link>
      <Link href="/risk/rules">Rules</Link>
      <Link href="/risk/history">History</Link>
    </nav>
  );
}

const caption = { textAlign: 'left', position: 'absolute', left: -9999 } as const;

/** The level is always a word, never colour alone. */
export const levelText = (l: RiskLevel) => RISK_LEVEL_LABELS[l];

/** Counts and ids, in words. Nothing here is personal: the evidence only ever holds counts and record ids. */
export function describeEvidence(e: RiskEvidence): string {
  const parts: string[] = [];
  if (e.count !== undefined) {
    parts.push(e.total !== undefined ? `${e.count} of ${e.total}` : `${e.count}`);
  }
  if (e.windowHours !== undefined) parts.push(`in the last ${e.windowHours} hours`);
  if (e.kinds?.length)
    parts.push(`kinds: ${e.kinds.join(', ').toLowerCase().replaceAll('_', ' ')}`);
  return parts.join(', ') || 'No further detail';
}

export function EventsTable({ events, label }: { events: RiskEventInfo[]; label: string }) {
  if (events.length === 0) return <p style={{ margin: 0 }}>No signals.</p>;
  return (
    <table style={styles.table}>
      <caption style={caption}>{label}</caption>
      <thead>
        <tr>
          {['Signal', 'Kind', 'Points', 'Status', 'Person', 'When'].map((h) => (
            <th key={h} scope="col" style={styles.th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
              <Link href={`/risk/events/${e.id}`}>{e.ruleLabel}</Link>
            </th>
            <td style={styles.td}>{RISK_CATEGORY_LABELS[e.category]}</td>
            <td style={styles.td}>{e.points}</td>
            <td style={styles.td}>{RISK_EVENT_STATUS_LABELS[e.status]}</td>
            <td style={styles.td}>
              {e.userId ? (
                <Link href={`/risk/users/${e.userId}`}>{e.userName ?? 'Unnamed person'}</Link>
              ) : (
                '—'
              )}
            </td>
            <td style={styles.td}>{formatWhen(e.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function NotesList({ notes }: { notes: RiskNoteInfo[] }) {
  if (notes.length === 0) return <p style={{ margin: 0 }}>No notes yet.</p>;
  return (
    <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
      {notes.map((n) => (
        <li key={n.id}>
          {formatWhen(n.createdAt)}, {n.authorName ?? 'a team member'}: {n.note}
        </li>
      ))}
    </ol>
  );
}
