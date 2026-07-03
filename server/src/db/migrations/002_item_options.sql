-- Per-item playback options (mute for videos)
ALTER TABLE playlist_items ADD COLUMN muted boolean NOT NULL DEFAULT false;
