import { styles } from '../drivers/styles';

/** Labels and values as a definition list, so a screen reader reads each label with its value. The one way a page lists facts. */
export function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl style={styles.definitionList}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={styles.dt}>{k}</dt>
          <dd style={styles.dd}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
