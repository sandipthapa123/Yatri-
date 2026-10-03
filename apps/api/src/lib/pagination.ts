import { z } from 'zod';

/**
 * The query parameters every list takes, defined once. A page is counted from 1; a page size (or a "limit") is at least 1 and
 * at most the route's own ceiling, with the route's own default.
 */
export const pageParam = z.coerce.number().int().min(1).default(1);

export const pageSizeParam = (max: number, fallback: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
