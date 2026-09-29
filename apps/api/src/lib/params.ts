import type { Request } from 'express';

/**
 * Express 5's route-param types allow `string | string[]` (repeated path
 * segments), even though a plain `:id`-style param is always a single
 * string at runtime. This narrows it once, in one place, instead of a
 * non-null-assertion-and-cast at every call site.
 */
export function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0]!;
  if (!value) throw new Error(`Missing required route param: ${name}`);
  return value;
}
