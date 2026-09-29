import { Pool, types } from 'pg';

import { env } from './env';

// Postgres DATE columns (OID 1082) come back as JS Date objects by default,
// which JSON.stringify() then serializes as a full timestamp
// ("1995-01-01T00:00:00.000Z") instead of the plain "YYYY-MM-DD" every
// consumer of this API actually expects (client-side date validation and
// form prefill, admin display). A date has no time component or timezone,
// so keep it exactly as the string Postgres sends over the wire.
types.setTypeParser(1082, (value) => value);

/**
 * A single pooled Postgres connection, shared across the app. `pg` connects
 * lazily on first query, so importing this module does not require a live
 * database — modules just import `pool` and query when they need to.
 */
export const pool = new Pool({ connectionString: env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Unexpected error on an idle PostgreSQL client', err);
});
