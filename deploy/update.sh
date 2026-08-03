#!/usr/bin/env bash
# Update an existing Galaxy Media install from this repo checkout.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/galaxy-media

if [[ $EUID -ne 0 ]]; then echo "run as root"; exit 1; fi

# Build in a staging copy and swap only on success. Syncing over the live
# install first (with --delete) meant a failed build - npm registry down, disk
# full, a TS error - left the service with no dist/ at all and nothing to roll
# back to, i.e. a dead screen fleet until someone debugged it by hand.
STAGE="$APP_DIR/.staging"

echo "==> Stage sources"
rm -rf "$STAGE"
mkdir -p "$STAGE"
rsync -a --exclude node_modules "$REPO_DIR/server/" "$STAGE/server/"
rsync -a --exclude node_modules --exclude dist "$REPO_DIR/admin/" "$STAGE/admin/"
# Reuse the existing node_modules as a starting point so npm ci is not a full
# cold download on every update.
[[ -d "$APP_DIR/server/node_modules" ]] && cp -al "$APP_DIR/server/node_modules" "$STAGE/server/node_modules" 2>/dev/null || true
[[ -d "$APP_DIR/admin/node_modules" ]] && cp -al "$APP_DIR/admin/node_modules" "$STAGE/admin/node_modules" 2>/dev/null || true

echo "==> Build (staged - the live install is untouched until this succeeds)"
if ! (cd "$STAGE/server" && npm ci && npm run build) \
  || ! (cd "$STAGE/admin" && npm ci && npm run build); then
  echo "BUILD FAILED - the running install was left exactly as it was." >&2
  rm -rf "$STAGE"
  exit 1
fi

echo "==> Back up the database before migrating"
# Migrations run on API start below. A dump first means a bad migration is
# recoverable rather than terminal.
if [[ -x "$APP_DIR/deploy/backup.sh" ]]; then
  bash "$APP_DIR/deploy/backup.sh" || echo "WARNING: pre-update backup failed; continuing" >&2
fi

echo "==> Swap in the new build"
rsync -a --delete "$STAGE/server/" "$APP_DIR/server/"
rsync -a --delete "$STAGE/admin/" "$APP_DIR/admin/"
rsync -a --delete "$REPO_DIR/deploy/" "$APP_DIR/deploy/"
chmod +x "$APP_DIR/deploy/"*.sh
rm -rf "$STAGE"
chown -R galaxy:galaxy "$APP_DIR"

echo "==> Restart (migrations run on startup)"
cp "$REPO_DIR/deploy/galaxy-api.service" /etc/systemd/system/
cp "$REPO_DIR/deploy/galaxy-backup.service" /etc/systemd/system/
cp "$REPO_DIR/deploy/galaxy-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now galaxy-backup.timer
systemctl restart galaxy-api
sleep 2
systemctl --no-pager status galaxy-api | head -5
