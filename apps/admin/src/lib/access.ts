import { ApiError } from './apiClient';

/**
 * Load a page's data, telling "you may not see this" (the API said 403) apart from a real failure.
 * The API is the only judge of access; the page just shows a plain explanation instead of a crash.
 */
export async function loadOrDenied<T>(
  load: () => Promise<T>,
): Promise<{ data: T; denied: false } | { data: null; denied: true }> {
  try {
    return { data: await load(), denied: false };
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return { data: null, denied: true };
    throw e;
  }
}
