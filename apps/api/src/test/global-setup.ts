import dotenv from 'dotenv';
import { Pool } from 'pg';

import { TEST_WORKERS } from './workers';

/**
 * Before the run: make one fresh database per worker as a copy of the migrated template (`yatri_test`, which
 * `pnpm migrate:test:up` keeps current), so the run always starts from the same state and a new migration reaches
 * every worker. After the run: drop the copies.
 */
dotenv.config({ path: '.env.test' });

function adminPool(): { pool: Pool; template: string; url: URL } {
  const url = new URL(process.env.DATABASE_URL as string);
  const template = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return { pool: new Pool({ connectionString: admin.toString(), max: 1 }), template, url };
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function drop(pool: Pool, name: string) {
  await pool.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [name],
  );
  await pool.query(`DROP DATABASE IF EXISTS ${quote(name)}`);
}

export async function setup() {
  const { pool, template } = adminPool();
  try {
    await pool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [template],
    );
    for (let i = 1; i <= TEST_WORKERS; i++) {
      const name = `${template}_w${i}`;
      await drop(pool, name);
      await pool.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(template)}`);
    }
  } finally {
    await pool.end();
  }
}

export async function teardown() {
  const { pool, template } = adminPool();
  try {
    for (let i = 1; i <= TEST_WORKERS; i++) await drop(pool, `${template}_w${i}`);
  } finally {
    await pool.end();
  }
}
