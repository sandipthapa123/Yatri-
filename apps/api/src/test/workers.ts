/**
 * How many test files run at once. Each worker gets its OWN Postgres database (a copy of the migrated
 * `yatri_test`) and its OWN Redis database number, so files that truncate tables and flush Redis cannot disturb each
 * other. Used by the vitest config, the global setup that makes the copies, and the per-worker environment.
 */
export const TEST_WORKERS = 4;
