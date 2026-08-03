-- Last uncaught exception reported by the player (CrashReporter, player-android),
-- the only signal available for a screen that crashes without the TV rebooting.
-- Sticky on purpose: a heartbeat reporting no crash leaves these untouched, so a
-- tech still sees "crashed on Tuesday" days later. Read them alongside the
-- timestamp, not as "is broken right now".
ALTER TABLE screens ADD COLUMN last_crash_at timestamptz;
ALTER TABLE screens ADD COLUMN last_crash_message text;
