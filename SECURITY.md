# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately - do not open a public issue.
Email the maintainer (see repository profile) with details and reproduction steps.
You will get a response within 7 days. Coordinated disclosure is appreciated.

## Threat model (summary)

- **A compromised TV / stolen device token** can fetch only that one screen's assigned
  content and send its own heartbeats. It cannot enumerate screens, read the media library,
  or reach any admin endpoint. Tokens are revocable instantly (unpair).
- **A compromised company account** is confined to its own company: all queries are
  tenant-scoped server-side from the authenticated principal, never client-supplied IDs.
- **An MSP editor account** is confined to its assigned company list, re-checked on every request.

## Key controls

- TLS 1.2+ only; no plaintext listener. HSTS, CSP, nosniff, frame-deny headers.
- Argon2id password hashing; TOTP 2FA mandatory for MSP-level accounts.
- Short-lived access JWTs + rotating revocable refresh tokens; device JWTs bound to a
  revocable per-screen `jti`.
- Uploads validated by magic bytes, stored under server-generated names, served only via
  signed expiring URLs.
- TOTP secrets encrypted at rest (AES-256-GCM); audit log of auth and admin actions.
- Hardened systemd unit (ProtectSystem=strict, syscall filter), ufw, fail2ban,
  unattended security upgrades.
