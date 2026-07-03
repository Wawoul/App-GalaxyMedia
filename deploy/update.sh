#!/usr/bin/env bash
# Update an existing Galaxy Media install from this repo checkout.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/galaxy-media

if [[ $EUID -ne 0 ]]; then echo "run as root"; exit 1; fi

echo "==> Sync sources"
rsync -a --delete --exclude node_modules "$REPO_DIR/server/" "$APP_DIR/server/"
rsync -a --delete --exclude node_modules --exclude dist "$REPO_DIR/admin/" "$APP_DIR/admin/"
rsync -a --delete "$REPO_DIR/deploy/" "$APP_DIR/deploy/"
chmod +x "$APP_DIR/deploy/"*.sh

echo "==> Build"
cd "$APP_DIR/server" && npm ci && npm run build
cd "$APP_DIR/admin" && npm ci && npm run build
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
