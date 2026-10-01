/**
 * Passenger experience (Phase 19).
 *
 *  - user_preferences: ONE row per person holding only the choices they made (a jsonb object keyed by the
 *    preference keys in @yatri/types), validated by the API against that one table. `version` goes up with every
 *    save so two devices cannot overwrite each other unseen. `recent_places_cleared_at` is the privacy control
 *    "clear my recent destinations": recent places are derived from rides, so clearing hides everything before it.
 *  - notifications.suppressed: a notification the person had switched off is still recorded in their history
 *    (the durable record of what happened) but was not pushed; this says so.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE user_preferences (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      choices jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(choices) = 'object'),
      version integer NOT NULL DEFAULT 0,
      recent_places_cleared_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE notifications ADD COLUMN suppressed boolean NOT NULL DEFAULT false;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE notifications DROP COLUMN suppressed;
    DROP TABLE user_preferences;
  `);
};
