import Link from 'next/link';
import { RISK_CATEGORY_LABELS } from '@yatri/types';

import { listRiskRules } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { RuleForm } from '../Forms';
import { RiskNav } from '../parts';

/** The rules that raise signals: what each looks for, and the numbers an administrator can change (audited). */
export default async function RiskRulesPage() {
  const token = await requireAdminAccessToken();
  const { data: rules, denied } = await loadOrDenied(() => listRiskRules(token));
  if (denied || !rules) return <NoAccess what="the risk rules" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Risk rules</h1>
        <Link href="/risk" style={styles.backLink}>
          ← Overview
        </Link>
      </div>
      <RiskNav />
      <p style={{ margin: 0 }}>
        Each rule raises a signal when a person&apos;s recent records pass its threshold. The same
        rules apply to every app. The thresholds for review and restriction are in Settings.
      </p>
      {rules.map((r, i) => (
        <section key={r.code} aria-labelledby={`r-${i}`} style={styles.section}>
          <h2 id={`r-${i}`} style={styles.sectionTitle}>
            {r.label}
          </h2>
          <p style={{ margin: 0 }}>
            {RISK_CATEGORY_LABELS[r.category]}. {r.enabled ? 'On' : 'Off'}.{' '}
            {r.customised ? 'Changed from the defaults.' : 'Using the defaults.'} Now: {r.points}{' '}
            points at {r.threshold} {r.unit} within {r.windowHours} hours.
          </p>
          <p style={{ margin: 0 }}>{r.help}</p>
          <details>
            <summary>Change this rule</summary>
            <RuleForm rule={r} />
          </details>
        </section>
      ))}
    </div>
  );
}
