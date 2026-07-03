# Galaxy Media - Build Prompt / Specification

**Galaxy Media** is a self-hosted digital signage platform. The name is used for branding
(admin UI, TV app name) and technical identifiers (`galaxy-api.service`, `/var/lib/galaxy-media`,
Android package `com.galaxymedia.player` - adjust if you own a matching domain).
The project may be open-sourced on GitHub later, so build it release-ready from day one (see §12).

> This file is the improved, complete version of the original request. Feed it to Claude Code
> (or any developer) as the source of truth. Edit anything before starting the build.

## Goal

Build a **self-hosted digital signage platform** with no per-screen licensing, consisting of:

1. **Server (CMS)** - "Galaxy Media Server", runs in a Proxmox **Ubuntu LXC container**, manages tenants, screens,
   media, playlists, layouts, and schedules through a web admin UI.
2. **Android TV player app** - "Galaxy Media Player", a native Kotlin APK sideloaded onto **TCL Android TVs** (and
   other Android TV devices) that pairs to the server with a short code and plays assigned
   content reliably, including when the network drops.

The operator is an **MSP**, so multi-tenancy is a first-class requirement: the MSP manages many
client companies, each with their own screens, media, and users, fully isolated from each other.

---

## 1. Tech stack (decided)

| Component | Choice |
|---|---|
| API server | Node.js 22 LTS + TypeScript, Fastify (or Express), REST + WebSocket |
| Database | PostgreSQL 16 |
| Admin UI | React + TypeScript (Vite), served by the same nginx |
| Media storage | Local filesystem on the LXC (e.g. `/var/lib/galaxy-media/media`), sized/validated on upload |
| Reverse proxy | nginx with HTTPS (Let's Encrypt or internal CA) |
| Process management | systemd units directly in the LXC - **no Docker** (avoids LXC nesting) |
| TV player | Native Kotlin, Android TV (API 24+), Media3/ExoPlayer for video, WebView for URLs |

## 2. Multi-tenancy model (MSP structure)

```
MSP (platform owner)
└── Company (tenant, e.g. "Joe's Gyms Ltd")
    └── Screen Group (e.g. "Reception screens", "All gyms - North region")
        └── Screen (one paired TV)
```

- **Companies** are hard-isolated: media, playlists, users, and screens never leak between tenants.
- **Screen groups** are the assignment unit: content is assigned to groups (or individual
  screens as an override). A screen belongs to exactly one company but may be in multiple groups;
  define a clear priority rule for conflicting assignments (direct-to-screen beats group,
  later-created group beats earlier, plus schedule priority - see §5).
- **Accounts & roles** - two levels of users, both managed from the admin UI:

  **MSP-level users** (your staff):
  - `msp_admin` - sees and manages everything: all companies, all screens, and **user accounts**
    (create/disable accounts, assign roles, reset 2FA).
  - `msp_editor` - a technician account. An `msp_admin` assigns which **companies** each
    `msp_editor` can see and edit (many-to-many "company access list"). Within those companies
    they can manage media, playlists, schedules, and screens; they cannot manage users, create
    companies, or touch companies outside their list. The access list is editable at any time
    and takes effect immediately (active sessions re-checked per request, not per login).

  **Company-level users** (optional accounts for the client themselves):
  - `company_admin` - full control within their own company only, including its users.
  - `company_editor` - manage media/playlists/schedules in their company; cannot manage users
    or unpair screens.
  - `company_viewer` - read-only dashboard (screen status).

  All permission checks resolve to a single server-side question: *"which companies can this
  user act on, and at what level?"* - so MSP editors and company users share one enforcement
  path (no separate code paths to get out of sync).

## 3. Device pairing (code-based linking)

1. Fresh app boots → registers anonymously with the server → server returns a **6-character
   pairing code**; the TV displays it full-screen with the server URL it's pointed at.
2. Admin enters the code in the web UI, chooses the company + group(s) + screen name.
3. Server issues the device a **long-lived device token (JWT)**; the TV stores it and switches
   to player mode. Codes expire after 15 minutes and regenerate automatically.
4. Screens can be **unpaired/revoked** from the UI (token invalidated; TV returns to pairing screen).
5. The app's server URL is configurable on first launch (settings screen) so the same APK works
   for any deployment.

## 4. Content management (MVP scope - all confirmed in)

- **Media library** (per company): upload images (jpg/png/webp) and videos (mp4/h.264-h.265);
  server generates thumbnails, stores duration/dimensions/checksums.
- **Web pages**: a "URL" content type rendered in the TV's WebView, with per-item refresh interval.
- **Playlists**: ordered items (media or URL) with per-item duration (videos default to their
  natural length), drag-to-reorder, enable/disable items.
- **Layouts / zones (split-screen)**: a layout is a named arrangement of rectangular zones
  (e.g. main area + sidebar + bottom ticker), each zone assigned its own playlist. Ship 4-5
  preset layouts (fullscreen, 2-zone L-shape, 3-zone with ticker, side-by-side) before building
  a freeform layout editor. Fullscreen = the default single-zone layout, so one code path.
- **Ticker zone type**: scrolling text lines managed in the UI (common signage need, cheap to add).

## 5. Scheduling / dayparting

- Assign **(layout + playlists) → screen group** with: date range, days of week, time window,
  and a **priority** number. Highest-priority schedule active at any moment wins.
- A **default/fallback** assignment per group plays when nothing is scheduled.
- **Screen on/off hours** per group (player blanks the screen and pauses downloads outside hours;
  optionally use HDMI-CEC-less "black screen" since app-level power control on TCL is unreliable).
- All times are **local to the screen's configured timezone** (per screen, default from group).

## 6. Android TV player app (Kotlin)

- **Boot behavior**: auto-start on TV boot (`BOOT_COMPLETED` receiver + persistent foreground
  service), auto-restart on crash, stays in the foreground (kiosk-style; document the TCL
  settings needed, e.g. disabling screensaver).
- **Offline-first (hard requirement)**: downloads all assigned media to local storage ahead of
  time (checksum-verified), plays from cache; if the server is unreachable it keeps playing the
  last-known schedule indefinitely. Specifically:
  - The full schedule (all dayparts, layouts, playlists) is persisted locally, so **dayparting
    keeps switching content offline** using the TV's local clock and stored timezone.
  - The cached state **survives TV reboots and power cuts** - a TV that boots with no network
    goes straight into playback from cache, no pairing screen, no error screen.
  - Media for *upcoming* scheduled content is downloaded in advance, not on first play.
  - URL items show a cached snapshot or are skipped when offline (configurable per item).
  - The dashboard shows the screen as offline, but the viewer in front of the TV never notices.
- **Sync**: WebSocket connection for instant push ("content changed", "reload", "unpair",
  "identify" - flashes screen name); falls back to HTTP polling every 60 s if WS is blocked.
- **Heartbeat** every 30-60 s: app version, IP, current item, storage free, uptime → powers the
  status dashboard.
- **Remote commands** from the UI: reload content, restart app, clear cache, take a screenshot
  (of the rendered content) for proof-of-play/support, trigger APK self-update.
- **Self-update**: server hosts APK releases; app checks version, downloads and prompts/installs
  (silent install isn't possible on stock TCL without device-owner provisioning - document both paths).
- **Rendering**: single Activity; zones are composed views - Media3 `PlayerView` for video,
  `ImageView` with preloading for images, `WebView` for URLs, custom marquee view for tickers.
  Hardware-accelerated, no black flashes between items (double-buffer image swaps, pre-buffer next video).

## 7. Monitoring & MSP dashboard

- Dashboard: all screens (filter by company/group), online/offline, last heartbeat, current
  content, app version, thumbnail of last screenshot.
- **Offline alerts**: screen offline > N minutes → email (SMTP settings in admin) - MSPs sell
  uptime, this is core, not optional.
- Basic **proof-of-play log** (what played where, daily rollups) - phase 2 if time-boxed.

## 8. Security (high priority - encrypt and harden throughout)

Security is a first-class requirement, not a checklist at the end. Screens hang in client
premises and the server may be internet-facing; assume both are hostile environments.

### Transport & encryption

- **TLS 1.2+ only, everywhere** - admin UI, API, WebSocket, media downloads, APK downloads.
  Modern cipher suites, HSTS, no plaintext HTTP listener (port 80 redirects only).
- **Encryption at rest**: enable storage-level encryption where the platform allows (ZFS/LUKS
  encrypted dataset for the Proxmox volume backing the LXC - document this in the install guide);
  additionally encrypt genuinely sensitive DB columns (SMTP credentials, any stored API keys)
  with AES-256-GCM using a key from `config.env`, never stored in the DB.
- **Backups encrypted**: `pg_dump` piped through `age`/GPG before leaving the host.
- Password hashing with **Argon2id**; all tokens generated from CSPRNG.

### Authentication & authorization

- Short-lived user access JWTs (≤15 min) + rotating refresh tokens (revocable, hashed in DB).
- **TOTP two-factor auth on all account types** (MSP and company users): mandatory for
  `msp_admin` and `msp_editor`, and an org-wide toggle to require it for company users too.
  Standard authenticator-app TOTP with one-time recovery codes shown at enrollment; admins can
  reset a user's 2FA (which forces re-enrollment at next login, never silently disables it).
- Device JWTs: per-device `jti` stored in DB, revocable instantly; scoped to device endpoints
  only (a stolen TV token must not be able to read the media library index, other screens,
  or any admin endpoint - only its own assigned content).
- Pairing codes: 6 chars from an unambiguous alphabet, 15-min expiry, single-use,
  **aggressively rate-limited** (per-IP and global) since they're the unauthenticated entry point.
- Every query tenant-scoped server-side (company_id derived from the authenticated principal - never from client-supplied IDs). Enforce in a repository/middleware layer with tests proving
  cross-tenant access fails (IDOR test suite).
- Account lockout with exponential backoff on failed logins; audit log of all auth events and
  admin actions (who, what, when, from which IP) - MSPs need this for client disputes.

### API & application hardening

- Strict input validation on every endpoint (zod schemas); uploads validated by **magic bytes**,
  not extension or Content-Type; uploaded files stored with server-generated names outside the
  web root and served only through authenticated, tenant-checked routes.
- Security headers via nginx/helmet: CSP (no `unsafe-inline`), `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`. CSRF protection on the admin UI (SameSite=Strict
  cookies or double-submit tokens).
- Rate limiting on all auth-adjacent and upload endpoints; request body size caps.
- Media/APK download URLs: short-lived signed URLs bound to the requesting device/user.
- Dependency hygiene: lockfiles committed, `npm audit`/Dependabot in CI, minimal dependency count.
- No stack traces or internal errors leaked to clients; structured server-side logging instead.

### Host / LXC hardening

The `install.sh` script applies all of this, not just the app:

- **Unprivileged LXC container**; app runs as the non-root `galaxy` user.
- systemd unit sandboxing: `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`,
  `NoNewPrivileges=yes`, `ReadWritePaths=` limited to media + log dirs, syscall filtering.
- **ufw**: only 443 (and 22 if wanted) open; PostgreSQL bound to localhost only.
- **fail2ban** on SSH and on the app's auth endpoints (parse the audit log).
- SSH: key-only auth, no root login. `unattended-upgrades` for security patches.
- nginx runs with minimal modules; server tokens off.

### Android TV app

- **Network security config**: cleartext traffic disabled; TLS required to the server. Optional
  certificate pinning mode for internal-CA deployments.
- Device token stored via Android Keystore-backed **EncryptedSharedPreferences**; never logged.
- APK **release-signed**; self-update verifies the download's signature/checksum against the
  server-published hash before installing (prevents a MITM'd or tampered APK).
- WebView for URL content: JavaScript enabled but file access, content access, and geolocation
  disabled; each URL item renders in an isolated WebView instance.
- No analytics/telemetry to third parties - the app talks only to the configured server.

### Process

- `SECURITY.md` with responsible-disclosure instructions (matters if open-sourced).
- Threat-model note in docs: what a compromised TV can reach (answer: only its own content),
  what a compromised client company admin can reach (answer: only their company).

## 9. Deployment (Proxmox Ubuntu LXC)

- Provide a **single install script** (`install.sh`) for a clean Ubuntu 24.04 LXC: installs
  Node, PostgreSQL, nginx, creates the `galaxy` system user, systemd units
  (`galaxy-api.service`), runs DB migrations, obtains/configures TLS.
- Config via `/etc/galaxy-media/config.env`. Documented backup story: `pg_dump` + media directory rsync.
- Provide an **update script** (pull release, migrate, restart) - the MSP will run many of these.

## 10. Build order (phases) - implementation status

All three phases are implemented (2026-07-02):

1. **Phase 1 - core loop** (done): DB schema + migrations, auth with TOTP 2FA, user management
   (all five roles including `msp_editor` company-access lists), companies/groups/screens, pairing flow,
   media upload (with folders), fullscreen playlists, device sync API, Kotlin player with
   offline-first caching, heartbeat + dashboard.
2. **Phase 2** (done): calendar scheduling/dayparting (incl. bi-weekly and one-off recurrence,
   Black Screen slots), URL content, zones/layouts + presets, ticker, remote commands
   (reload/identify/restart/clear cache/screenshot), offline alerts (email + Telegram,
   global and per-company recipients, managed in the Alerts tab).
3. **Phase 3** (done): APK self-update from the System tab, on-demand screenshots,
   proof-of-play reports (90-day retention, CSV export), custom-zone layouts,
   white-label brand name per company. Plus: config export/import between companies,
   nightly backups (systemd timer).

Beyond the spec, also built: a **web player** at `/player` (any browser in kiosk mode -
pairing, playlists, layouts/tickers, schedules, streams, remote commands; best-effort
offline via the browser cache), Docker Compose deployment, config export/import,
nightly backups, and live stream (HLS/DASH) playlist items.

Still open: drag-to-move/resize calendar blocks, a canvas-based layout editor (custom
zones are numeric percentages today), per-company Telegram chats, media quality
variants (server-side transcoding), and an Electron shell around the web player for a
Windows player with real offline support.

## 11. Non-goals (for now)

- No cloud/SaaS billing, no per-screen licensing (the whole point), no iOS/tvOS/Fire TV players,
  no interactive/touch content, no video walls (multi-screen sync), no RS-232/HDMI-CEC TV power control.

## 12. Open-source readiness

The repo may be published on GitHub, so from the first commit:

- **No secrets in the repo** - everything sensitive comes from `config.env`; ship a committed
  `config.env.example` with placeholders. Same for the Android app (no baked-in server URLs or keys).
- **Choose a license early**: MIT/Apache-2.0 maximizes adoption; **AGPL-3.0** prevents someone
  hosting Galaxy Media as a paid SaaS without contributing back - pick based on how you feel
  about commercial reuse (decide before publishing, changing later is painful).
- **README with screenshots**, quick-start (LXC install script), and APK install instructions - this is what makes or breaks a self-hosted project's adoption.
- Clean git history (no test credentials or client names ever committed - as an MSP, keep real
  client/company names out of seed data, fixtures, and screenshots).
- CI (GitHub Actions): lint, typecheck, tests, and an APK build on every push.

## 13. Acceptance criteria (MVP)

- A fresh TCL Android TV with the APK sideloaded shows a pairing code; an MSP admin pairs it into
  a client company group in under a minute.
- Uploading media and reordering a playlist updates the TV within ~10 seconds without touching the TV.
- Pulling the TV's network cable mid-playback: content keeps looping; on reconnect it resyncs silently.
- Two companies' admins can never see each other's screens or media (verified by tests).
- An `msp_editor` sees exactly the companies on their access list - nothing else appears in any
  list, search, or API response; removing a company from their list locks them out immediately
  (verified by tests).
- Rebooting the TV returns it to playback with no remote-control interaction.
- Rebooting the TV **while the network is down** still returns it to full playback from cache,
  with dayparting switching content at the right local times.
- An unauthenticated scan of the server exposes only 443; a captured device token can fetch only
  that screen's own content (verified by tests).
