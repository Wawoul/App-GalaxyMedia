-- Proof-of-play log (SPEC §7): one row per item shown on a screen.
-- Retention: rows older than 90 days are pruned by the server's daily cleanup.
CREATE TABLE proof_of_play (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  screen_id   uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  item_name   text NOT NULL,
  played_at   timestamptz NOT NULL
);
CREATE INDEX proof_of_play_company ON proof_of_play(company_id, played_at);
CREATE INDEX proof_of_play_screen ON proof_of_play(screen_id, played_at);

-- Latest support screenshot per screen (file on disk, timestamp here).
ALTER TABLE screens ADD COLUMN screenshot_at timestamptz;

-- White-label: shown to viewers (TV idle screen) and company users instead of "Galaxy Media".
ALTER TABLE companies ADD COLUMN brand_name text NOT NULL DEFAULT '';

-- Freeform layouts: preset 'custom' stores its own zone geometry in zones.custom.
ALTER TABLE layouts DROP CONSTRAINT layouts_preset_check;
ALTER TABLE layouts ADD CONSTRAINT layouts_preset_check
  CHECK (preset IN ('main-side', 'main-ticker', 'main-side-ticker', 'split-2', 'custom'));
