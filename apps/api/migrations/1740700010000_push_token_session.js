/**
 * A push token belongs to the sign-in (session) that registered it. Until now it belonged only to the person, so signing a
 * phone out from another device (a lost phone) revoked its session but left its token: the phone kept receiving that person's
 * notifications. With the link, ending a session removes its tokens (and so does deleting the session row).
 * Tokens registered before this change have no session; the app registers again on its next launch.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumn('push_tokens', {
    session_id: { type: 'uuid', references: 'auth_sessions', onDelete: 'CASCADE' },
  });
  pgm.createIndex('push_tokens', ['session_id']);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropIndex('push_tokens', ['session_id']);
  pgm.dropColumn('push_tokens', 'session_id');
};
