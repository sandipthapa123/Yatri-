import Link from 'next/link';

import { styles } from '../drivers/styles';

/** Shown when the API says the signed-in administrator does not hold the permission for a page. */
export function NoAccess({ what }: { what: string }) {
  return (
    <div style={styles.page}>
      <h1 style={styles.title}>You do not have access to {what}</h1>
      <p style={{ margin: 0 }}>
        Your administrator account does not include this permission. If you need it, ask an
        administrator who can manage administrators.
      </p>
      <Link href="/">Back to the dashboard</Link>
    </div>
  );
}
