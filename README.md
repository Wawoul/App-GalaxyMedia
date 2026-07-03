# Galaxy Media

Self-hosted digital signage for MSPs. No per-screen licensing - your server, your screens.

## What it does

- **Multi-tenant**: MSP -> companies -> screen groups -> screens, with hard isolation
  between companies and per-editor company access lists.
- **Content**: media library with folders, playlists (images, videos with per-item
  mute, live web pages), split-screen layouts (presets or custom zones) with scrolling
  tickers, and white-label branding per company.
- **Scheduling**: drag-on-calendar weekly scheduler with dayparting, overnight windows,
  bi-weekly/one-off recurrence, priorities, and a "Black Screen" mode that simulates
  the TV being off. Schedules run on the TV's own clock, so they keep switching offline.
- **Players**: a native Android TV app (TCL etc.) that caches everything locally
  (checksum-verified), keeps playing through network outages and reboots, and
  self-updates from releases published in the admin - plus a zero-install **web player**
  (`/player` in any browser) for kiosk PCs, Raspberry Pis, and quick previews.
  Both pair with a 6-character code.
- **Operations**: live dashboard (online/offline, now playing, screenshots on demand),
  offline alerts by email + Telegram (global and per-company recipients), proof-of-play
  reports with CSV export, config export/import between companies, nightly backups.
- **Security**: TLS-only, Argon2id + mandatory TOTP 2FA for MSP staff, encrypted secrets
  at rest, scoped revocable device tokens, signed download URLs, audit log, hardened
  systemd/nginx/ufw/fail2ban deployment. See [SECURITY.md](SECURITY.md).

## Components

| Directory | What |
|---|---|
| `server/` | Node.js 22 + TypeScript + Fastify + PostgreSQL API |
| `admin/` | React admin UI (Vite), which also serves the web player at `/player` |
| `player-android/` | Kotlin Android TV player (Media3/ExoPlayer) |
| `deploy/` | Hardened install/update/backup scripts for an Ubuntu LXC |

See [SPEC.md](SPEC.md) for the full specification and implementation status, and
[AppBuild.md](AppBuild.md) for a step-by-step walkthrough of building the TV app.

## Install

You need two things: this server somewhere on a network your TVs can reach, and the
player APK on the TVs. Pick ONE of the server options below.

### Option A - Docker Compose (easiest)

Anything that runs Docker: a NAS, a VPS, a VM, a Raspberry Pi 4+.

```bash
git clone <this-repo> && cd <this-repo>
cp .env.example .env
# edit .env: set BASE_URL and generate the three secrets
#   openssl rand -hex 24   -> DB_PASSWORD
#   openssl rand -hex 48   -> JWT_SECRET
#   openssl rand -hex 32   -> ENCRYPTION_KEY
docker compose up -d
```

The admin UI and API are now on port 8080 (plain HTTP). Put TLS in front - any of:

- **Caddy / nginx / Traefik** reverse-proxying `localhost:8080` with a Let's Encrypt cert
- **Cloudflare Tunnel**: public hostname -> `http://<host>:8080` (free trusted TLS, no open ports)

Set `BASE_URL` in `.env` to that public https URL (TVs embed it in download links), then
`docker compose up -d` again. Log in with the `BOOTSTRAP_ADMIN_*` credentials from `.env`
and enroll 2FA. Updates: `git pull && docker compose up -d --build`.

Backups in Docker: dump the DB and copy the media volume, e.g.
`docker compose exec db pg_dump -U galaxy galaxy_media > backup.sql` on a cron.

### Option B - bare-metal script (Proxmox LXC / Ubuntu VM)

On a clean Ubuntu 24.04 machine (2 vCPU / 2 GB RAM is plenty to start):

```bash
git clone <this-repo> && cd <this-repo>
sudo bash deploy/install.sh
```

The script installs Node 22, PostgreSQL and nginx, generates all secrets, applies the
security hardening (ufw, fail2ban, sandboxed systemd unit, unattended upgrades, TLS-only
nginx), enables the nightly backup timer, and prints the first admin login. Point a
domain (or a Cloudflare Tunnel) at it and set up the certificate as the script instructs.
Updates: `sudo bash deploy/update.sh` from a fresh checkout.

### Then: put a player on each screen

**Android TVs (recommended for unattended screens - full offline support):**

1. Get the player APK: use a prebuilt one from this project's GitHub Releases, or build
   your own - full beginner walkthrough and the signing trade-offs in [AppBuild.md](AppBuild.md).
2. Upload it in the admin's **System** tab (this also gives you a download link for new TVs).
3. Sideload it once per TV (USB stick or adb), enter your server URL, pair with the
   on-screen code. All future app updates ship from the System tab automatically.

**Any browser (kiosk PCs, Raspberry Pi, quick previews - needs connectivity):**

First enable the web player in the admin's **System** tab (it is off by default). Then
open `https://your-server/player`, pair with the on-screen code, done. For a dedicated
device run the browser in kiosk mode, e.g. on a Pi or PC:

```bash
chromium --kiosk --autoplay-policy=no-user-gesture-required https://your-server/player
```

The web player supports playlists, layouts/tickers, schedules, streams, and remote
commands. It relies on the browser's cache, so prefer the Android app for screens
that must keep playing through network outages unattended.

## Development

```bash
# API server (needs PostgreSQL running; see server/config.env.example)
cd server && npm install && npm run migrate && npm run dev

# Admin UI (proxies /api to localhost:8080)
cd admin && npm install && npm run dev

# TV app: open player-android/ in Android Studio, run on an Android TV device/emulator

# Tests / typecheck
cd server && npm test && npm run typecheck
cd admin && npm run typecheck
```

## Contributing / security

Issues and PRs welcome. For vulnerabilities please follow [SECURITY.md](SECURITY.md)
(private disclosure, no public issues).
