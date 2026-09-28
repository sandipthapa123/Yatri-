'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { adminLogin, ApiError } from '../../lib/apiClient';
import {
  ACCESS_COOKIE,
  ACCESS_COOKIE_MAX_AGE_SECONDS,
  baseCookieOptions,
  REFRESH_COOKIE,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
} from '../../lib/session';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

export interface LoginFormState {
  error?: string;
  fieldErrors?: { email?: string; password?: string };
}

function friendlyLoginError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_CREDENTIALS') return 'Invalid email or password.';
    if (err.code === 'ACCOUNT_SUSPENDED') return 'This admin account has been suspended.';
    if (err.code === 'ACCOUNT_DEACTIVATED') return 'This admin account has been deactivated.';
    if (err.code === 'RATE_LIMITED') return 'Too many attempts. Please wait and try again.';
    if (err.code === 'VALIDATION_ERROR') return 'Enter a valid email and password.';
  }
  return 'Something went wrong. Please try again.';
}

export async function loginAction(
  _prevState: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    return {
      error: 'Please fix the highlighted fields.',
      fieldErrors: { email: fieldErrors.email?.[0], password: fieldErrors.password?.[0] },
    };
  }

  let session;
  try {
    session = await adminLogin(parsed.data.email, parsed.data.password);
  } catch (err) {
    return { error: friendlyLoginError(err) };
  }

  const cookieStore = await cookies();
  cookieStore.set(ACCESS_COOKIE, session.accessToken, {
    ...baseCookieOptions(),
    maxAge: ACCESS_COOKIE_MAX_AGE_SECONDS,
  });
  cookieStore.set(REFRESH_COOKIE, session.refreshToken, {
    ...baseCookieOptions(),
    maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS,
  });

  redirect('/');
}
