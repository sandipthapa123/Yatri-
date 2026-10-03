import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import { pool } from '../config/database';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<T>(text, params);
}

/**
 * Thrown inside a transaction to undo everything it did and still answer normally: `withTransaction` rolls back and returns
 * `value`. For "nothing to do after all" (a duplicate event, an empty statement), where nothing failed but nothing may be kept.
 */
export class Rollback<T> {
  constructor(readonly value: T) {}
}

/**
 * Run `work` in one transaction on one connection: committed if it returns, rolled back if it throws (and, for a thrown
 * `Rollback`, rolled back and its value returned). Rows a guarded update depends on are locked inside it with `FOR UPDATE`.
 * The ONE way the API runs a transaction.
 */
export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof Rollback) return err.value as T;
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres's code for an error, when it is one (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

/**
 * A write refused because it would break a unique rule (a second open offer, a duplicate registration). The one test for it;
 * `constraint` narrows it to one named rule when a write can collide with more than one.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return (
    pgCode(err) === '23505' &&
    (!constraint || (err as { constraint?: string }).constraint === constraint)
  );
}

/** A write refused because something it points at does not exist (an unknown category, a deleted user). */
export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === '23503';
}
