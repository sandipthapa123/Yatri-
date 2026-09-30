import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { APP_NAME } from '@yatri/shared';

import { getAdminMe } from '../../lib/apiClient';
import { requireAdminAccessToken } from '../../lib/session';
import { logoutAction } from '../actions';
import { styles } from './drivers/styles';
import { Nav } from './ui/Nav';

/**
 * The console shell every signed-in page shares: skip link first, then the header (name, who is
 * signed in, sign out), the main menu (only what this administrator may open), and ONE main
 * landmark. Pages render inside it and never add their own.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const token = await requireAdminAccessToken();
  let me;
  try {
    // The authoritative check (the token alone does not prove the session is still valid).
    me = await getAdminMe(token);
  } catch {
    redirect('/login');
  }
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to the main content
      </a>
      <header className="console-header">
        <p className="console-brand">{APP_NAME} Admin</p>
        <Nav permissions={me.permissions} />
        <form
          action={logoutAction}
          style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}
        >
          <span style={{ fontSize: 14 }}>Signed in as {me.fullName ?? 'administrator'}</span>
          <button type="submit" style={styles.buttonSecondary}>
            Sign out
          </button>
        </form>
      </header>
      <main id="main" tabIndex={-1} className="console-main">
        {children}
      </main>
    </>
  );
}
