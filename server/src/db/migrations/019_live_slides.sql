-- Live slides: a design with widgets (clock, date, weather) or animation cannot be a still picture,
-- so it plays as a web page the server hosts (/live.html) through the existing "web page" playlist
-- item. `live` says which designs are in that mode; its playlist entries are URL items rather than
-- media items. The rendered PNG still exists (library thumbnail, and what a static copy would show).
ALTER TABLE designs ADD COLUMN live boolean NOT NULL DEFAULT false;

-- A live slide's playlist entries are identified by the URL they carry. Whichever way the slide is
-- removed (the designer, deleting its image in the library, deleting a folder, deleting the company)
-- those entries must go with it, or a TV would be left showing a page that no longer exists.
CREATE FUNCTION designs_drop_live_items() RETURNS trigger AS $$
BEGIN
  IF OLD.live THEN
    DELETE FROM playlist_items WHERE url LIKE '%/live.html?d=' || OLD.id::text || '&s=%';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER designs_live_cleanup BEFORE DELETE ON designs
  FOR EACH ROW EXECUTE FUNCTION designs_drop_live_items();
