#!/usr/bin/env bash
# Galaxy Media - hardened install for a clean Ubuntu 24.04 LXC (unprivileged).
# Run as root: sudo bash deploy/install.sh
set -euo pipefail

DOMAIN="${DOMAIN:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/galaxy-media
CONF_DIR=/etc/galaxy-media
DATA_DIR=/var/lib/galaxy-media

if [[ $EUID -ne 0 ]]; then echo "run as root"; exit 1; fi
if [[ -z "$DOMAIN" ]]; then
  read -rp "Public hostname for this server (e.g. signage.example.com): " DOMAIN
fi

echo "==> Packages"
apt-get update
apt-get install -y curl ca-certificates gnupg rsync nginx postgresql ufw fail2ban unattended-upgrades openssl

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> System user + directories"
id galaxy &>/dev/null || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin galaxy
mkdir -p "$APP_DIR" "$CONF_DIR" "$DATA_DIR/media"
chown -R galaxy:galaxy "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> PostgreSQL"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='galaxy'" | grep -q 1 || {
  DB_PASS=$(openssl rand -hex 24)
  sudo -u postgres psql -c "CREATE ROLE galaxy LOGIN PASSWORD '$DB_PASS'"
  sudo -u postgres psql -c "CREATE DATABASE galaxy_media OWNER galaxy"
  sudo -u postgres psql -d galaxy_media -c "CREATE EXTENSION IF NOT EXISTS citext"
  sudo -u postgres psql -d galaxy_media -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
  echo "DB_PASS_GENERATED=$DB_PASS"
}

echo "==> Config"
if [[ ! -f "$CONF_DIR/config.env" ]]; then
  ADMIN_PASS=$(openssl rand -base64 18)
  cat > "$CONF_DIR/config.env" <<EOF
DATABASE_URL=postgres://galaxy:${DB_PASS:-CHANGE_ME}@localhost:5432/galaxy_media
HOST=127.0.0.1
PORT=8080
BASE_URL=https://$DOMAIN
JWT_SECRET=$(openssl rand -hex 48)
ENCRYPTION_KEY=$(openssl rand -hex 32)
MEDIA_DIR=$DATA_DIR/media
MAX_UPLOAD_MB=512
BOOTSTRAP_ADMIN_EMAIL=admin@$DOMAIN
BOOTSTRAP_ADMIN_PASSWORD=$ADMIN_PASS
EOF
  chown root:galaxy "$CONF_DIR/config.env"
  chmod 640 "$CONF_DIR/config.env"
  echo "==> First admin: admin@$DOMAIN / $ADMIN_PASS  (change after first login)"
fi

echo "==> Build & deploy app"
rsync -a --delete --exclude node_modules "$REPO_DIR/server/" "$APP_DIR/server/"
rsync -a --delete --exclude node_modules --exclude dist "$REPO_DIR/admin/" "$APP_DIR/admin/"
cd "$APP_DIR/server" && npm ci && npm run build
cd "$APP_DIR/admin" && npm ci && npm run build
chown -R galaxy:galaxy "$APP_DIR"

echo "==> systemd"
cp "$REPO_DIR/deploy/galaxy-api.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable galaxy-api

echo "==> nginx"
sed "s/signage.example.com/$DOMAIN/g" "$REPO_DIR/deploy/nginx-galaxy.conf" \
  > /etc/nginx/sites-available/galaxy-media
ln -sf /etc/nginx/sites-available/galaxy-media /etc/nginx/sites-enabled/galaxy-media
rm -f /etc/nginx/sites-enabled/default
if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  echo "!! No TLS cert found. Either:"
  echo "   apt install certbot python3-certbot-nginx && certbot --nginx -d $DOMAIN"
  echo "   or install your internal-CA cert, then: systemctl reload nginx"
fi
nginx -t && systemctl reload nginx || true

echo "==> Firewall + fail2ban + auto security updates"
ufw allow 443/tcp
ufw allow 22/tcp
ufw --force enable
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Start"
systemctl restart galaxy-api
sleep 2
systemctl --no-pager status galaxy-api | head -5

echo
echo "Done. Admin UI: https://$DOMAIN  (after TLS is set up)"
echo "Config: $CONF_DIR/config.env - backup this file plus pg_dump + $DATA_DIR/media"
