-- Galaxy Media - Phase 1 schema

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ── Tenancy ────────────────────────────────────────────────────────────────

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Users & auth ───────────────────────────────────────────────────────────

-- level 'msp' users have company_id NULL; level 'company' users must have one.
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  display_name   text NOT NULL,
  level          text NOT NULL CHECK (level IN ('msp', 'company')),
  role           text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  company_id     uuid REFERENCES companies(id) ON DELETE CASCADE,
  totp_secret_enc text,          -- AES-256-GCM encrypted, NULL until enrolled
  totp_enabled   boolean NOT NULL DEFAULT false,
  recovery_codes text[] NOT NULL DEFAULT '{}',  -- sha256 hashes, consumed on use
  disabled       boolean NOT NULL DEFAULT false,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_level_company CHECK (
    (level = 'msp' AND company_id IS NULL) OR
    (level = 'company' AND company_id IS NOT NULL)
  ),
  CONSTRAINT users_msp_no_viewer CHECK (NOT (level = 'msp' AND role = 'viewer'))
);

-- Which companies an msp_editor may manage.
CREATE TABLE user_company_access (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,     -- sha256 of the opaque token
  expires_at  timestamptz NOT NULL,
  revoked     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id);

-- ── Screens ────────────────────────────────────────────────────────────────

CREATE TABLE screen_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Europe/London',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX screen_groups_company ON screen_groups(company_id);

CREATE TABLE screens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name              text NOT NULL,
  timezone          text,                    -- NULL = inherit from first group / default
  device_token_jti  uuid,                    -- NULL = revoked/unpaired
  paired_at         timestamptz,
  -- status (updated by heartbeats)
  last_seen_at      timestamptz,
  app_version       text,
  ip                text,
  current_item      text,
  storage_free_mb   int,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX screens_company ON screens(company_id);

CREATE TABLE screen_group_members (
  screen_id  uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  group_id   uuid NOT NULL REFERENCES screen_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (screen_id, group_id)
);

-- Pairing: created when a fresh device registers; claimed by an admin.
CREATE TABLE pairing_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- device's temporary identity
  code         text NOT NULL,                               -- 6-char display code
  expires_at   timestamptz NOT NULL,
  screen_id    uuid REFERENCES screens(id) ON DELETE SET NULL,  -- set when claimed
  device_token text,                                        -- delivered to device once, then cleared
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pairing_requests_code_active
  ON pairing_requests(code) WHERE screen_id IS NULL;

-- ── Content ────────────────────────────────────────────────────────────────

CREATE TABLE media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('image', 'video')),
  original_name  text NOT NULL,
  mime           text NOT NULL,
  size_bytes     bigint NOT NULL,
  sha256         text NOT NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_company ON media(company_id);

CREATE TABLE playlists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX playlists_company ON playlists(company_id);

-- An item is either media or a URL (Phase 2 enables URL rendering on the player).
CREATE TABLE playlist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id  uuid NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position     int NOT NULL,
  media_id     uuid REFERENCES media(id) ON DELETE CASCADE,
  url          text,
  duration_ms  int,          -- NULL: video natural length / image default (10s)
  enabled      boolean NOT NULL DEFAULT true,
  CONSTRAINT playlist_items_one_source CHECK (
    (media_id IS NOT NULL AND url IS NULL) OR (media_id IS NULL AND url IS NOT NULL)
  )
);
CREATE INDEX playlist_items_playlist ON playlist_items(playlist_id, position);

-- Phase 1: default assignments (no schedule yet). Direct-to-screen beats group;
-- newest created wins within each. Schedule columns arrive in Phase 2.
CREATE TABLE assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  playlist_id  uuid NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  screen_id    uuid REFERENCES screens(id) ON DELETE CASCADE,
  group_id     uuid REFERENCES screen_groups(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignments_one_target CHECK (
    (screen_id IS NOT NULL AND group_id IS NULL) OR (screen_id IS NULL AND group_id IS NOT NULL)
  )
);
CREATE INDEX assignments_company ON assignments(company_id);

-- ── Audit ──────────────────────────────────────────────────────────────────

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  company_id  uuid,
  action      text NOT NULL,        -- e.g. 'auth.login', 'screen.pair', 'media.delete'
  entity      text,
  entity_id   text,
  ip          text,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log(created_at);
CREATE INDEX audit_log_company ON audit_log(company_id, created_at);
