-- Why the player could not download its media, reported on the heartbeat.
-- A screen that cannot fetch its files plays nothing and is indistinguishable,
-- from the dashboard, from one that is simply idle - so the reason never
-- reached anyone without physical access to the TV.
ALTER TABLE screens ADD COLUMN media_error text;
