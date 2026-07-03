-- Split-screen layouts (SPEC §4): preset zone arrangements, each zone playing
-- its own playlist; the ticker zone shows scrolling text lines.
CREATE TABLE layouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  preset      text NOT NULL CHECK (preset IN ('main-side', 'main-ticker', 'main-side-ticker', 'split-2')),
  -- { "main": "<playlistId>", "side": "<playlistId>", "ticker": { "texts": ["line", ...] } }
  zones       jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX layouts_company ON layouts(company_id);

-- Assignments may now target a layout instead of a single playlist.
ALTER TABLE assignments ADD COLUMN layout_id uuid REFERENCES layouts(id) ON DELETE CASCADE;
ALTER TABLE assignments DROP CONSTRAINT assignments_playlist_or_blackout;
ALTER TABLE assignments ADD CONSTRAINT assignments_content CHECK (
  (playlist_id IS NOT NULL)::int + (layout_id IS NOT NULL)::int + blackout::int = 1
);
