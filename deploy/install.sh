#!/usr/bin/env bash
# Galaxy Media - hardened install for a clean Ubuntu 24.04 LXC/VM.
# Run as root: sudo bash deploy/install.sh
#
# The script asks two or three questions and prints a summary at the end.
# Non-interactive use (automation): set the answers as env vars, e.g.
#   MODE=public DOMAIN=signage.example.com sudo -E bash deploy/install.sh
#   MODE=lan sudo -E bash deploy/install.sh          # auto-detects the IP
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/galaxy-media
CONF_DIR=/etc/galaxy-media
DATA_DIR=/var/lib/galaxy-media

if [[ $EUID -ne 0 ]]; then echo "run as root"; exit 1; fi

echo "Galaxy Media installer"
echo

# ── Questions ───────────────────────────────────────────────────────────────

MODE="${MODE:-}"
if [[ -z "$MODE" ]]; then
  echo "How will screens and admins reach this server?"
  echo "  1) Public HTTPS domain - internet-facing or via a tunnel/VPN (recommended)"
  echo "  2) LAN only - plain http:// and this machine's IP address"
  read -rp "Choose [1]: " choice
  if [[ "${choice:-1}" == "2" ]]; then MODE=lan; else MODE=public; fi
fi

DOMAIN="${DOMAIN:-}"
if [[ "$MODE" == "public" ]]; then
  while [[ -z "$DOMAIN" ]]; do
    read -rp "Public hostname (e.g. signage.example.com): " DOMAIN
  done
  BASE_URL="https://$DOMAIN"
else
  DETECTED_IP="$(hostname -I | awk '{print $1}')"
  if [[ -z "$DOMAIN" ]]; then
    read -rp "Server LAN IP [$DETECTED_IP]: " DOMAIN
    DOMAIN="${DOMAIN:-$DETECTED_IP}"
  fi
  BASE_URL="http://$DOMAIN"
fi

ADMIN_EMAIL="${ADMIN_EMAIL:-}"
if [[ -z "$ADMIN_EMAIL" ]]; then
  if [[ "$MODE" == "public" ]]; then DEFAULT_EMAIL="admin@$DOMAIN"; else DEFAULT_EMAIL="admin@galaxymedia.local"; fi
  read -rp "First admin login email [$DEFAULT_EMAIL]: " ADMIN_EMAIL
  ADMIN_EMAIL="${ADMIN_EMAIL:-$DEFAULT_EMAIL}"
fi

echo

# ── Install ─────────────────────────────────────────────────────────────────

echo "==> Packages"
apt-get update
apt-get install -y curl ca-certificates gnupg rsync nginx postgresql ufw fail2ban unattended-upgrades openssl \
  python3 make g++  # argon2's native module ships prebuilt binaries for most platforms;
                     # these are the fallback if that lookup fails (notably on ARM boards)

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
}

echo "==> Config"
if [[ -f "$CONF_DIR/config.env" ]]; then
  ADMIN_PASS="(unchanged - existing config kept, see $CONF_DIR/config.env)"
else
  ADMIN_PASS=$(openssl rand -base64 18)
  cat > "$CONF_DIR/config.env" <<EOF
DATABASE_URL=postgres://galaxy:${DB_PASS:-CHANGE_ME}@localhost:5432/galaxy_media
HOST=127.0.0.1
PORT=8080
BASE_URL=$BASE_URL
JWT_SECRET=$(openssl rand -hex 48)
ENCRYPTION_KEY=$(openssl rand -hex 32)
MEDIA_DIR=$DATA_DIR/media
MAX_UPLOAD_MB=512
BOOTSTRAP_ADMIN_EMAIL=$ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD=$ADMIN_PASS
EOF
  chown root:galaxy "$CONF_DIR/config.env"
  chmod 640 "$CONF_DIR/config.env"
fi

echo "==> Build & deploy app"
rsync -a --delete --exclude node_modules "$REPO_DIR/server/" "$APP_DIR/server/"
rsync -a --delete --exclude node_modules --exclude dist "$REPO_DIR/admin/" "$APP_DIR/admin/"
cd "$APP_DIR/server" && npm ci && npm run build
cd "$APP_DIR/admin" && npm ci && npm run build
chown -R galaxy:galaxy "$APP_DIR"

echo "==> systemd + nightly backups"
cp "$REPO_DIR/deploy/galaxy-api.service" /etc/systemd/system/
cp "$REPO_DIR/deploy/galaxy-backup.service" /etc/systemd/system/
cp "$REPO_DIR/deploy/galaxy-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable galaxy-api
systemctl enable --now galaxy-backup.timer

echo "==> nginx"
if [[ "$MODE" == "public" ]]; then
  sed "s/signage.example.com/$DOMAIN/g" "$REPO_DIR/deploy/nginx-galaxy.conf" \
    > /etc/nginx/sites-available/galaxy-media
else
  cp "$REPO_DIR/deploy/nginx-galaxy-lan.conf" /etc/nginx/sites-available/galaxy-media
fi
ln -sf /etc/nginx/sites-available/galaxy-media /etc/nginx/sites-enabled/galaxy-media
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx || true

echo "==> Firewall + fail2ban + auto security updates"
ufw allow 22/tcp
ufw allow 80/tcp
[[ "$MODE" == "public" ]] && ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Start"
systemctl restart galaxy-api
sleep 2
systemctl --no-pager status galaxy-api | head -3

# ── Summary ─────────────────────────────────────────────────────────────────

echo
echo "=============================================================="
echo "  Galaxy Media is installed and running"
echo
echo "  Admin UI:   $BASE_URL"
if [[ "$MODE" == "public" ]]; then
  echo "              (after the TLS certificate below is set up)"
fi
echo "  Login:      $ADMIN_EMAIL"
echo "  Password:   $ADMIN_PASS"
echo "              (change it and enroll 2FA at first login)"
echo
echo "  Config:     $CONF_DIR/config.env  <- back this up (holds the encryption keys)"
echo "  Media:      $DATA_DIR/media"
echo "  Backups:    nightly to /var/backups/galaxy-media (galaxy-backup.timer)"
echo "  Service:    systemctl status galaxy-api"
echo "  Update:     sudo bash deploy/update.sh (from a fresh checkout)"
echo
echo "  Next steps:"
STEP=1
if [[ "$MODE" == "public" ]]; then
  echo "  $STEP. Get a TLS certificate:"
  echo "     apt install certbot python3-certbot-nginx && certbot --nginx -d $DOMAIN"
  echo "     (or point a Cloudflare Tunnel at http://localhost:80 instead)"
  STEP=$((STEP + 1))
fi
echo "  $STEP. Log in at $BASE_URL and enroll 2FA (mandatory)"
STEP=$((STEP + 1))
echo "  $STEP. Upload the player APK in the System tab, then pair your first TV"
echo "=============================================================="
