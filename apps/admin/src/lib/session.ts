import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { env } from './env';

export const ACCESS_COOKIE = 'yatri_admin_access';
export const REFRESH_COOKIE = 'yatri_admin_refresh';

// Client-side cookie lifetime hints only — the server-issued JWT/session
// expiry is what's actually enforced.
export const ACCESS_COOKIE_MAX_AGE_SECONDS = 15 * 60;
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface AdminAccessClaims {
  sub: string;
  sid: string;
  role: string;
}

/**
 * Verifies the access-token JWT locally (same secret as apps/api) so
 * middleware can gate every dashboard navigation without a network round
 * trip. This only checks the token's signature/expiry/role — it does NOT
 * re-check session revocation or account status server-side on every
 * request the way apps/api's `authenticate` middleware does. That's an
 * intentional latency/strictness trade-off for page navigation; the
 * access token's short (15 min) lifetime bounds how stale that check can
 * get, and any actual data request to the API is still re-validated there.
 */
export function verifyAdminAccessToken(token: string): AdminAccessClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof (decoded as Record<string, unknown>).sub !== 'string' ||
      typeof (decoded as Record<string, unknown>).sid !== 'string' ||
      (decoded as Record<string, unknown>).role !== 'ADMIN'
    ) {
      return null;
    }
    const { sub, sid, role } = decoded as { sub: string; sid: string; role: string };
    return { sub, sid, role };
  } catch {
    return null;
  }
}

/**
 * Reads the admin access token cookie for a Server Component/Action, or
 * redirects to /login if it's missing. Middleware already gates page
 * navigation, but Server Actions run outside that path, and every page here
 * needs the raw token anyway to call the API — so this is the one place
 * that logic lives, rather than each page re-deriving it.
 */
export async function requireAdminAccessToken(): Promise<string> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_COOKIE)?.value;
  if (!token) redirect('/login');
  return token;
}

export function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}
