import { NextResponse, type NextRequest } from 'next/server';

import { refreshAdminSession } from './lib/apiClient';
import {
  ACCESS_COOKIE,
  ACCESS_COOKIE_MAX_AGE_SECONDS,
  baseCookieOptions,
  REFRESH_COOKIE,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
  verifyAdminAccessToken,
} from './lib/session';

export async function proxy(req: NextRequest) {
  const isLoginPath = req.nextUrl.pathname === '/login';
  const accessToken = req.cookies.get(ACCESS_COOKIE)?.value;
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;

  let claims = accessToken ? verifyAdminAccessToken(accessToken) : null;
  let refreshedCookies: { access: string; refresh: string } | null = null;

  // Access token missing/expired but we still have a refresh token: try a
  // silent refresh so a dashboard reload doesn't bounce an active admin to
  // the login page every 15 minutes.
  if (!claims && refreshToken) {
    try {
      const session = await refreshAdminSession(refreshToken);
      const newClaims = verifyAdminAccessToken(session.accessToken);
      if (newClaims) {
        claims = newClaims;
        refreshedCookies = { access: session.accessToken, refresh: session.refreshToken };
      }
    } catch {
      // Refresh token invalid/expired/revoked — fall through as unauthenticated.
    }
  }

  function withRefreshedCookies(response: NextResponse): NextResponse {
    if (refreshedCookies) {
      response.cookies.set(ACCESS_COOKIE, refreshedCookies.access, {
        ...baseCookieOptions(),
        maxAge: ACCESS_COOKIE_MAX_AGE_SECONDS,
      });
      response.cookies.set(REFRESH_COOKIE, refreshedCookies.refresh, {
        ...baseCookieOptions(),
        maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS,
      });
    }
    return response;
  }

  if (claims) {
    if (isLoginPath) {
      return withRefreshedCookies(NextResponse.redirect(new URL('/', req.url)));
    }
    return withRefreshedCookies(NextResponse.next());
  }

  if (isLoginPath) {
    return NextResponse.next();
  }

  const response = NextResponse.redirect(new URL('/login', req.url));
  response.cookies.delete(ACCESS_COOKIE);
  response.cookies.delete(REFRESH_COOKIE);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
