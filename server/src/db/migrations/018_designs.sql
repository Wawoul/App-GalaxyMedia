-- Slide designer. A design is the editable source of a slide; its published
-- form is an ordinary image row in `media` (rendered by the browser), so
-- playlists, schedules, layouts and the TVs need no changes.
--
-- Each save publishes a NEW media row and swaps playlist items over to it: the
-- Android cache is keyed by media id and only refetches on a size change, so
-- overwriting a file in place would leave TVs on the old slide.
CREATE TABLE designs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  width       int  NOT NULL,
  height      int  NOT NULL,
  document    jsonb NOT NULL,
  -- NULL for templates (never published). Deleting the rendered image deletes the design.
  media_id    uuid REFERENCES media(id) ON DELETE CASCADE,
  is_template boolean NOT NULL DEFAULT false,
  version     int  NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT designs_size CHECK ((width = 1920 AND height = 1080) OR (width = 1080 AND height = 1920)),
  CONSTRAINT designs_published CHECK (is_template = (media_id IS NULL))
);
CREATE INDEX designs_company ON designs(company_id, is_template);
CREATE UNIQUE INDEX designs_media ON designs(media_id) WHERE media_id IS NOT NULL;
