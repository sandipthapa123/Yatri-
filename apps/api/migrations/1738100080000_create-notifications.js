/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Foundation for notifying users of account/verification events. `type` is
 * a free-form string rather than an enum on purpose — new notification
 * types are an app-layer concern (see NotificationService) that shouldn't
 * need a migration to add. Delivery (push/SMS/email) is a separate,
 * pluggable concern (see lib/notifications/provider.ts); this table is
 * just the durable record of "what was there to notify about," independent
 * of whether any particular delivery channel succeeded.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('notifications', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    type: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    read_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('notifications', ['user_id', 'created_at']);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('notifications');
};
