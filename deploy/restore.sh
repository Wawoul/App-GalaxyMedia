#!/usr/bin/env bash
# Galaxy Media restore: database + media + config from a backup.sh directory.
#
#   sudo bash deploy/restore.sh /var/backups/galaxy-media/2026-08-03_0330
#
# backup.sh writes pg_dump's custom format, so this needs pg_restore, not psql -
# piping a custom-format dump into psql gives a binary-garbage error, which is a
# miserable thing to discover during an outage.
#
# config.env is restored too, and it matters more than it looks: ENCRYPTION_KEY
# decrypts 2FA secrets and stored SMTP/Telegram credentials, so a database
# restored alongside a *different* key leaves all of those permanently unreadable.
set -euo pipefail

SRC="${1:-}"
APP_USER=galaxy
CONF_DIR=/etc/galaxy-media
DATA_DIR=/var/lib/galaxy-media

if [[ -z "$SRC" ]]; then
  echo "usage: sudo bash restore.sh <backup-directory>" >&2
  echo >&2
  echo "available backups:" >&2
  ls -1d /var/backups/galaxy-media/*/ 2>/dev/null >&2 || echo "  (none found)" >&2
  exit 1
fi
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
[[ -f "$SRC/galaxy_media.dump" ]] || { echo "no galaxy_media.dump in $SRC" >&2; exit 1; }

# Verify the archive before touching anything that is currently working.
pg_restore -l "$SRC/galaxy_media.dump" >/dev/null 2>&1 \
  || { echo "ERROR: $SRC/galaxy_media.dump is not a readable pg_dump archive" >&2; exit 1; }

cat <<MSG
About to restore from: $SRC

This REPLACES the current database, media library and config:
  - database galaxy_media is dropped and recreated
  - $DATA_DIR/media is replaced
  - $CONF_DIR/config.env is replaced (if present in the backup)

MSG
read -rp "Type RESTORE to continue: " confirm
[[ "$confirm" == "RESTORE" ]] || { echo "aborted"; exit 1; }

echo "==> Stopping the API"
systemctl stop galaxy-api || true

echo "==> Restoring the database"
# Terminate stragglers so DROP DATABASE can proceed.
sudo -u postgres psql -q -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='galaxy_media' AND pid <> pg_backend_pid()" \
  >/dev/null
sudo -u postgres psql -q -c "DROP DATABASE IF EXISTS galaxy_media"
sudo -u postgres psql -q -c "CREATE DATABASE galaxy_media OWNER $APP_USER"
sudo -u postgres psql -q -d galaxy_media -c "CREATE EXTENSION IF NOT EXISTS citext"
sudo -u postgres psql -q -d galaxy_media -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
# --no-owner: the dump may name a role that differs on this host.
sudo -u postgres pg_restore --no-owner -d galaxy_media "$SRC/galaxy_media.dump"

if [[ -d "$SRC/media" ]]; then
  echo "==> Restoring media"
  mkdir -p "$DATA_DIR/media"
  rsync -a --delete "$SRC/media/" "$DATA_DIR/media/"
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
fi

if [[ -f "$SRC/config.env" ]]; then
  echo "==> Restoring config (keeps encrypted fields readable)"
  install -m 640 -o root -g "$APP_USER" "$SRC/config.env" "$CONF_DIR/config.env"
fi

echo "==> Starting the API (migrations run on boot)"
systemctl start galaxy-api
sleep 3
if curl -fsS localhost:8080/api/health >/dev/null 2>&1; then
  echo "restore complete - API healthy"
else
  echo "restore finished but the API is not answering; check: journalctl -u galaxy-api -n 50" >&2
  exit 1
fi
