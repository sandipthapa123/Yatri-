/**
 * A ride has at most ONE open offer at a time. Dispatch checked this in code (`openOfferForTrip`), but two dispatch runs at the same
 * moment (a decline and the sweep, or two servers) could both see "no open offer" and both offer the ride, to different drivers.
 * The database now refuses the second one.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    -- Keep only the earliest open offer of any ride that already has several (a unique index cannot be built over duplicates).
    UPDATE trip_offers o SET status = 'CANCELLED', responded_at = now()
    WHERE o.status = 'OFFERED'
      AND EXISTS (SELECT 1 FROM trip_offers e WHERE e.trip_id = o.trip_id AND e.status = 'OFFERED'
                  AND (e.expires_at, e.id) < (o.expires_at, o.id));
    CREATE UNIQUE INDEX trip_offers_one_open_per_trip ON trip_offers (trip_id) WHERE status = 'OFFERED';
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS trip_offers_one_open_per_trip;');
};
