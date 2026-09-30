#!/usr/bin/env bash
# Restore a Yatri backup into a database.
#
#   TARGET_DATABASE_URL=postgres://.../yatri_restore \
#     deploy/scripts/restore-db.sh backups/yatri-20260101T000000Z.dump
#
# This REPLACES the contents of the target database, so it refuses to run unless you say so:
#   CONFIRM_RESTORE=yes
# Restore into a NEW, empty database first (a "restore drill") and check it before pointing the API
# at it; never restore over the live database while the API is running (stop it first).
# The dump is verified against its checksum before anything is touched.
set -euo pipefail

file="${1:?usage: restore-db.sh <backup .dump file>}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL must be set (the database to restore INTO)}"
[ "${CONFIRM_RESTORE:-}" = "yes" ] || {
  echo "Refusing: this replaces the target database. Re-run with CONFIRM_RESTORE=yes." >&2
  exit 2
}
[ -f "$file" ] || { echo "No such file: $file" >&2; exit 2; }

if [ -f "$file.sha256" ]; then
  ( cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" )
else
  echo "Warning: no checksum file next to the backup; its integrity is unverified." >&2
fi

pg_restore --list "$file" >/dev/null   # unreadable dump: stop before changing anything
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error \
  --dbname="$TARGET_DATABASE_URL" "$file"

echo "restore ok into the target database. Next: run the checks in docs/OPERATIONS.md (restore drill)."
