import Link from 'next/link';

import { styles } from '../../drivers/styles';
import { CampaignForm } from '../Forms';

/** A new campaign always starts as a draft: nothing reaches a rider until it is started on its own page. */
export default function NewCampaignPage() {
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Create a campaign</h1>
        <Link href="/campaigns" style={styles.backLink}>
          ← Campaigns
        </Link>
      </div>
      <CampaignForm />
    </div>
  );
}
