import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_NAME } from '@yatri/shared';

import { getAdminMe } from '../lib/apiClient';
import { ACCESS_COOKIE } from '../lib/session';
import { logoutAction } from './actions';

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_COOKIE)?.value;

  // Middleware already checked the JWT's signature/expiry, but not whether
  // the session has since been revoked or the account suspended — this
  // authoritative check against the API is what actually enforces that.
  if (!accessToken) redirect('/login');
  let admin;
  try {
    admin = await getAdminMe(accessToken);
  } catch {
    redirect('/login');
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <h1 style={{ color: 'var(--color-primary)', fontSize: 32, margin: 0 }}>{APP_NAME} Admin</h1>
      <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
        Signed in as {admin.fullName ?? admin.id}.
      </p>
      <p style={{ color: 'var(--color-text-secondary)', maxWidth: 420, margin: 0 }}>
        The operations dashboard foundation is set up. Fleet, trip, and payout views ship in a later
        phase.
      </p>
      <form action={logoutAction}>
        <button
          type="submit"
          style={{
            minHeight: 44,
            padding: '0 20px',
            borderRadius: 999,
            border: '1px solid var(--color-border)',
            background: 'transparent',
            color: 'var(--color-text-primary)',
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
