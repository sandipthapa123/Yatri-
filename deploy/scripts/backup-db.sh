#!/usr/bin/env bash
# Back up the Yatri database to a compressed, checksummed file, and prune old ones.
#
#   DATABASE_URL=postgres://... BACKUP_DIR=/var/backups/yatri deploy/scripts/backup-db.sh
#
# Run it from cron or a scheduler (daily at minimum; see docs/OPERATIONS.md for the schedule and for
# copying the file OFF the machine, which is what makes it a backup). It writes:
#   yatri-<UTC timestamp>.dump         (pg_dump custom format: restorable with pg_restore, selectively)
#   yatri-<UTC timestamp>.dump.sha256  (verify with: sha256sum -c <file>.sha256)
# It never prints the connection string. Exit status is non-zero on ANY failure, so a scheduler can alert.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
umask 077   # a backup holds personal data: readable by its owner only

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/yatri-$stamp.dump"
tmp="$out.partial"

# Write to a temporary name, so a crash never leaves a half-written file that looks complete.
trap 'rm -f "$tmp"' EXIT
pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$tmp" "$DATABASE_URL"

# A dump that pg_restore cannot read is worthless: prove it can list its own contents.
pg_restore --list "$tmp" >/dev/null

mv "$tmp" "$out"
trap - EXIT
( cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )

# Retention: remove backups older than KEEP_DAYS (and their checksums).
find "$BACKUP_DIR" -maxdepth 1 -name 'yatri-*.dump*' -type f -mtime +"$KEEP_DAYS" -delete

echo "backup ok: $out ($(du -h "$out" | cut -f1))"
