import type { QueryResultRow } from 'pg';

import { pool } from '../config/database';

export function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<T>(text, params);
}
