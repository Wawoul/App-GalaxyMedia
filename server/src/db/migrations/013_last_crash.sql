-- Last uncaught exception reported by the player (CrashReporter, player-android),
-- the only signal available for a screen that crashes without the TV rebooting.
ALTER TABLE screens ADD COLUMN last_crash_at timestamptz;
ALTER TABLE screens ADD COLUMN last_crash_message text;
