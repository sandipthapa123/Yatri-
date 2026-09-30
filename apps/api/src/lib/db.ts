import type { PoolClient, QueryResultRow } from 'pg';

import { pool } from '../config/database';

export function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<T>(text, params);
}

/**
 * Run `work` in one transaction on one connection: committed if it returns, rolled back if it throws.
 * Rows a guarded update depends on are locked inside it with `FOR UPDATE`.
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
    throw err;
  } finally {
    client.release();
  }
}
