import type { ApiErrorShape, ApiResponse, AppUser } from '@yatri/shared';

import { API_BASE_URL } from './config';
import { connectivity } from './connectivity';
import { IDEMPOTENCY_HEADER_NAME, withIdempotentRetry } from './idempotency';
import { serverClock } from './serverClock';
import type { DriverProfile, RequestOtpResponse, UserRole, VerifyOtpResponse } from './types';

// The one API error type, shared with the admin site.
import { ApiError } from '@yatri/shared';
export { ApiError };

/** The words for "the request never reached the server". The same text everywhere, spoken by screen readers. */
export const NETWORK_ERROR_MESSAGE =
  'Could not reach Yatri. Check your internet connection and try again.';

/** How long a request may wait for an answer; an upload of a photo or document is given longer. */
export const REQUEST_TIMEOUT_MS = 20_000;
export const UPLOAD_TIMEOUT_MS = 60_000;
export const TIMEOUT_ERROR_MESSAGE =
  'Yatri did not answer in time. Check your internet connection and try again.';

/**
 * The one place a request leaves the device. It also keeps what the app knows about its connection (every answer, even
 * an error answer, proves the network works; a failure to reach the server is recorded) and the server's clock (from
 * the response `Date`), and turns "fetch threw" into a plain ApiError with code NETWORK_ERROR.
 */
async function send(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const sentAt = Date.now();
  let response: Response;
  // A request that gets no answer must end: on a stalled connection a screen would otherwise wait for ever. The caller's own
  // signal still cancels it, and that is told apart from running out of time.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const caller = init.signal ?? undefined;
  const onCallerAbort = () => controller.abort();
  if (caller?.aborted) controller.abort();
  else caller?.addEventListener('abort', onCallerAbort, { once: true });
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (caller?.aborted) throw err; // the caller cancelled; that is not a network problem
    connectivity.reportUnreachable();
    // Same code as a dropped connection (an action sent with an idempotency key is safely sent again), plainer words.
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      timedOut ? TIMEOUT_ERROR_MESSAGE : NETWORK_ERROR_MESSAGE,
    );
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', onCallerAbort);
  }
  connectivity.reportReachable();
  const date = response.headers?.get?.('date');
  if (date) serverClock.observe(Date.parse(date), sentAt, Date.now());
  return response;
}

async function unwrap<T>(response: Response): Promise<T> {
  let payload: ApiResponse<T>;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      'INVALID_RESPONSE',
      'The server returned an invalid response.',
    );
  }

  if (!payload.success) {
    const error: ApiErrorShape = payload.error;
    throw new ApiError(response.status, error.code, error.message, error.details);
  }
  return payload.data;
}

/** Exported so other domain-specific API clients (e.g. the driver app's onboarding/vehicles/documents calls) can reuse the same request/error-unwrapping logic instead of duplicating it. */
export async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    accessToken?: string;
    signal?: AbortSignal;
    /**
     * For an action that must not happen twice (requesting, accepting, starting, completing, cancelling, paying):
     * the request carries an Idempotency-Key and is sent again with the same key if the network fails before an
     * answer, so a dropped connection never means a duplicate or a lost action.
     */
    idempotent?: boolean;
  } = {},
): Promise<T> {
  const once = async (key?: string) => {
    const response = await send(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
        ...(key ? { [IDEMPOTENCY_HEADER_NAME]: key } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    return unwrap<T>(response);
  };
  return options.idempotent ? withIdempotentRetry(once) : once();
}

/** A file selected on-device (e.g. via expo-image-picker), ready to attach to a FormData upload. */
export interface PickedFile {
  uri: string;
  name: string;
  type: string;
}

export async function requestMultipart<T>(
  path: string,
  accessToken: string,
  form: FormData,
): Promise<T> {
  const response = await send(
    `${API_BASE_URL}${path}`,
    {
      method: 'POST',
      // No Content-Type here — fetch sets the multipart boundary itself.
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    },
    UPLOAD_TIMEOUT_MS,
  );
  return unwrap<T>(response);
}

export function requestOtp(phoneNumber: string, role: UserRole): Promise<RequestOtpResponse> {
  return request<RequestOtpResponse>('/auth/request-otp', {
    method: 'POST',
    body: { phoneNumber, role },
  });
}

export function verifyOtp(
  phoneNumber: string,
  role: UserRole,
  code: string,
): Promise<VerifyOtpResponse> {
  return request<VerifyOtpResponse>('/auth/verify-otp', {
    method: 'POST',
    body: { phoneNumber, role, code },
  });
}

export function refreshTokens(refreshToken: string) {
  return request<Omit<VerifyOtpResponse, 'user' | 'isNewUser' | 'driverStatus'>>('/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  });
}

export function logout(accessToken: string, allDevices = false): Promise<{ loggedOut: true }> {
  return request('/auth/logout', { method: 'POST', accessToken, body: { allDevices } });
}

export function getMe(accessToken: string): Promise<AppUser> {
  return request<AppUser>('/users/me', { accessToken });
}

export function updateMe(
  accessToken: string,
  update: { fullName?: string; profilePictureUrl?: string | null },
): Promise<AppUser> {
  return request<AppUser>('/users/me', { method: 'PATCH', accessToken, body: update });
}

export function uploadProfilePicture(accessToken: string, file: PickedFile): Promise<AppUser> {
  const form = new FormData();
  // React Native's FormData accepts { uri, name, type } for file parts; the
  // DOM lib types don't know that shape, hence the cast.
  form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
  return requestMultipart<AppUser>('/users/me/profile-picture', accessToken, form);
}

export function deactivateAccount(accessToken: string): Promise<{ deactivated: true }> {
  return request('/users/me/deactivate', { method: 'POST', accessToken });
}

export function getDriverMe(accessToken: string): Promise<DriverProfile> {
  return request<DriverProfile>('/drivers/me', { accessToken });
}

export function updateDriverMe(
  accessToken: string,
  update: { fullName?: string; profilePictureUrl?: string | null },
): Promise<DriverProfile> {
  return request<DriverProfile>('/drivers/me', { method: 'PATCH', accessToken, body: update });
}
