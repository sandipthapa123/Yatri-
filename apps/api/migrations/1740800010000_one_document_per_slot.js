/**
 * A document slot (a driver or a vehicle, and a document type) holds at most ONE document. The upload code looked for an
 * existing document, then inserted: two uploads at once (a double tap, a retry on a weak connection) both found none and both
 * inserted, leaving two documents in one slot, of which a later replacement removed only one. The database now refuses the second.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    -- Keep one document per slot where there are already several: an approved one first, then the newest.
    DELETE FROM documents d USING (
      SELECT id, row_number() OVER (
        PARTITION BY owner_type, driver_user_id, vehicle_id, document_type_id
        ORDER BY (status = 'APPROVED') DESC, uploaded_at DESC, id DESC) AS keep_rank
      FROM documents
    ) r
    WHERE d.id = r.id AND r.keep_rank > 1;

    CREATE UNIQUE INDEX documents_one_per_driver_slot ON documents (driver_user_id, document_type_id)
      WHERE owner_type = 'DRIVER';
    CREATE UNIQUE INDEX documents_one_per_vehicle_slot ON documents (vehicle_id, document_type_id)
      WHERE owner_type = 'VEHICLE';
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS documents_one_per_driver_slot;
    DROP INDEX IF EXISTS documents_one_per_vehicle_slot;
  `);
};
