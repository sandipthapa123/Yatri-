import { formatWhen } from '@yatri/types';
import type { AuditEntry } from '@yatri/types';

import { styles } from '../drivers/styles';

/** Who did what to this record, oldest first. The list itself comes from the one audit log. */
export function AuditTrail({ entries }: { entries: AuditEntry[] }) {
  return (
    <section aria-labelledby="audit-h" style={styles.section}>
      <h2 id="audit-h" style={styles.sectionTitle}>
        Audit trail
      </h2>
      {entries.length === 0 ? (
        <p style={{ margin: 0 }}>Nothing recorded yet.</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          {entries.map((e) => (
            <li key={e.id}>
              {formatWhen(e.createdAt)}: {e.action.replaceAll('_', ' ').toLowerCase()} by{' '}
              {e.actorName ?? (e.actorRole ? e.actorRole.toLowerCase() : 'the system')}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
