import { getAdminMe, listAdminAccounts } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { PermissionsForm } from './PermissionsForm';

/** Administrators and what each may do. Only someone who manages administrators can open this. */
export default async function AdminsPage() {
  const token = await requireAdminAccessToken();
  const { data, denied } = await loadOrDenied(async () => {
    const [admins, me] = await Promise.all([listAdminAccounts(token), getAdminMe(token)]);
    return { admins, me };
  });
  if (denied || !data) return <NoAccess what="administrator management" />;
  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Administrators</h1>
      <p style={{ margin: 0 }}>
        Each administrator can do only what their permissions allow. You can grant only permissions
        you hold, and you cannot change your own.
      </p>
      {data.admins.map((a) => (
        <section key={a.id} aria-labelledby={`a-${a.id}`} style={styles.section}>
          <h2 id={`a-${a.id}`} style={styles.sectionTitle}>
            {a.fullName ?? a.email ?? 'Administrator'}
            {a.isYou ? ' (you)' : ''}
          </h2>
          <p style={{ margin: 0 }}>
            {a.email ?? 'No email'}. Account {a.status.toLowerCase()}.
          </p>
          <PermissionsForm admin={a} mine={data.me.permissions} />
        </section>
      ))}
    </div>
  );
}
