-- "Black Screen" assignments: no playlist, the TV renders pure black.
-- Simulates the TV being off for sets without power scheduling.
ALTER TABLE assignments ALTER COLUMN playlist_id DROP NOT NULL;
ALTER TABLE assignments ADD COLUMN blackout boolean NOT NULL DEFAULT false;
ALTER TABLE assignments ADD CONSTRAINT assignments_playlist_or_blackout
  CHECK (playlist_id IS NOT NULL OR blackout);

-- Per-company alert recipients (comma separated). Global recipients from the
-- Alerts tab always receive everything; these are added for that company's screens.
ALTER TABLE companies ADD COLUMN alert_emails text NOT NULL DEFAULT '';
