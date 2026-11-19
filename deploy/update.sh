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

echo "==> Install deploy scripts and systemd units"
rsync -a --delete "$REPO_DIR/deploy/" "$APP_DIR/deploy/"
chmod 755 "$APP_DIR/deploy/"*.sh "$APP_DIR/deploy/tests/"*.sh 2>/dev/null || true
# Owned by ROOT, never by the app user. Root runs these (the nightly backup, this very
# updater), so if the unprivileged API user could edit them, a compromised API would be
# one nightly timer away from root. This used to be undone by a blanket
# `chown -R galaxy:galaxy "$APP_DIR"` that re-owned them on every update.
chown -R root:root "$APP_DIR/deploy"
# ...and the folder holding it: whoever owns a directory can rename or replace anything
# inside it, root-owned contents or not. The app only reads from here (its service
# sandbox cannot write to /opt at all), so root ownership costs it nothing.
chown root:root "$APP_DIR"
chmod 755 "$APP_DIR"
cp "$REPO_DIR/deploy/galaxy-api.service" /etc/systemd/system/
cp "$REPO_DIR/deploy/galaxy-backup.service" /etc/systemd/system/
cp "$REPO_DIR/deploy/galaxy-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now galaxy-backup.timer

echo "==> Swap in the new build, restart (migrations run on startup), verify, roll back on failure"
# The new build must be readable by the app user; the deploy folder above stays root's.
chown -R galaxy:galaxy "$STAGE"
if ! bash "$REPO_DIR/deploy/swap-release.sh" "$APP_DIR" "$STAGE" \
  "curl -fsS http://127.0.0.1:8080/api/health" "systemctl restart galaxy-api"; then
  rm -rf "$STAGE"
  echo >&2
  echo "UPDATE FAILED: the new build did not start, so the previous one was put back." >&2
  echo "Database migrations are applied before the API starts and are NOT undone; they are" >&2
  echo "additive, so the previous build keeps working. A pre-update backup is in" >&2
  echo "/var/backups/galaxy-media if you need to restore (deploy/restore.sh)." >&2
  exit 1
fi
rm -rf "$STAGE"
systemctl --no-pager status galaxy-api | head -5
