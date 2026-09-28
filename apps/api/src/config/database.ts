import { Pool } from 'pg';

import { env } from './env';

/**
 * A single pooled Postgres connection, shared across the app. `pg` connects
 * lazily on first query, so importing this module does not require a live
 * database — modules just import `pool` and query when they need to.
 */
export const pool = new Pool({ connectionString: env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Unexpected error on an idle PostgreSQL client', err);
});
