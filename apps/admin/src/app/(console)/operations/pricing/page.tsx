import Link from 'next/link';
import { describeWindow } from '@yatri/types';

import { getOperationOptions, listPricingRules } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { PricingRuleForm } from '../Forms';

/**
 * Dynamic pricing rules. A rule raises the fare by a multiplier in a zone, at certain times, for a
 * vehicle type, while demand is high, or for a special event. The engine picks the highest matching
 * rule (they do not add up) and never exceeds the platform limit in Settings. Riders always see the
 * resulting fare before they confirm; the apps never work it out.
 */
export default async function PricingPage() {
  const token = await requireAdminAccessToken();
  const { data, denied } = await loadOrDenied(async () => ({
    rules: await listPricingRules(token),
    options: await getOperationOptions(token),
  }));
  if (denied || !data) return <NoAccess what="pricing rules" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Pricing rules</h1>
        <Link href="/operations" style={styles.backLink}>
          ← Demand, zones and pricing
        </Link>
      </div>
      {data.rules.length === 0 ? (
        <p style={{ margin: 0 }}>No rules: everyone pays the normal fare.</p>
      ) : null}
      {data.rules.map((r) => (
        <section key={r.id} aria-label={r.name} style={styles.section}>
          <p style={{ margin: 0 }}>
            <strong>{r.name}</strong> · {r.multiplier} times ·{' '}
            {r.isActive ? 'in use' : 'not in use'} · shown to riders as &quot;{r.label}&quot; ·{' '}
            {r.zoneName ? `in ${r.zoneName}` : 'everywhere'} ·{' '}
            {r.vehicleCategoryLabel ?? 'every vehicle type'} · {describeWindow(r.window)}
            {r.minDemandRatio !== null
              ? ` · only while requests per available driver are at least ${r.minDemandRatio}`
              : ''}
          </p>
          <PricingRuleForm rule={r} options={data.options} />
        </section>
      ))}
      <section aria-labelledby="new-h" style={styles.section}>
        <h2 id="new-h" style={styles.sectionTitle}>
          Add a rule
        </h2>
        <PricingRuleForm options={data.options} />
      </section>
    </div>
  );
}
