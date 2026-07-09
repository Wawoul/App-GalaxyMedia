-- A screen re-sends its buffered plays whenever a heartbeat's response is
-- lost (e.g. right as it comes back online), even though the server already
-- committed the first insert - producing duplicate rows with identical
-- (screen_id, item_name, played_at). Dedup on that triple so the retry is a
-- harmless no-op; two genuinely distinct plays never share a millisecond
-- timestamp from the same device.
ALTER TABLE proof_of_play ADD CONSTRAINT proof_of_play_dedup
  UNIQUE (screen_id, item_name, played_at);
