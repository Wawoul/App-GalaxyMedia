-- A screen re-sends its buffered plays whenever a heartbeat's response is
-- lost (e.g. right as it comes back online), even though the server already
-- committed the first insert - producing duplicate rows with identical
-- (screen_id, item_name, played_at). Dedup on that triple so the retry is a
-- harmless no-op; two genuinely distinct plays never share a millisecond
-- timestamp from the same device.

-- Existing installs will already carry duplicates from before the fix, and
-- ADD CONSTRAINT would abort on them - which, since migrations run at
-- startup inside a transaction, would leave the service unable to boot.
-- Clear them out first, keeping the lowest id of each group.
DELETE FROM proof_of_play p
USING proof_of_play keep
WHERE p.screen_id = keep.screen_id
  AND p.item_name = keep.item_name
  AND p.played_at = keep.played_at
  AND p.id > keep.id;

ALTER TABLE proof_of_play ADD CONSTRAINT proof_of_play_dedup
  UNIQUE (screen_id, item_name, played_at);
