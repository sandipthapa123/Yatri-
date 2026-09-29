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

/**
 * Yatri stores Nepali names, addresses and chat in Devanagari. A database created with a legacy
 * encoding (e.g. WIN1252, the Windows default) silently rejects or mangles it, so the API
 * refuses to start against anything but UTF8. Create the database with `ENCODING 'UTF8'`.
 */
export async function assertUtf8Database(): Promise<void> {
  const r = await pool.query<{ enc: string }>(
    'SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()',
  );
  const enc = r.rows[0]?.enc;
  if (enc !== 'UTF8') {
    throw new Error(
      `The database encoding is ${enc ?? 'unknown'} but Yatri requires UTF8 (Nepali text). ` +
        "Recreate it with: CREATE DATABASE <name> ENCODING 'UTF8' TEMPLATE template0;",
    );
  }
}
