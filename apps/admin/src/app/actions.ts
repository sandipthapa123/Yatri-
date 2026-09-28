'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { logoutAdminSession } from '../lib/apiClient';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../lib/session';

export async function logoutAction() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_COOKIE)?.value;

  if (accessToken) {
    try {
      await logoutAdminSession(accessToken);
    } catch {
      // Best-effort revoke — cookies are cleared regardless below.
    }
  }

  cookieStore.delete(ACCESS_COOKIE);
  cookieStore.delete(REFRESH_COOKIE);
  redirect('/login');
}
