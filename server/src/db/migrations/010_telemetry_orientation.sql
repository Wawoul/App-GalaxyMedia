-- Richer device telemetry (reported by heartbeats) and per-screen display
-- rotation (0/90/180/270 degrees, applied by the players in software).
ALTER TABLE screens ADD COLUMN battery_pct  int;
ALTER TABLE screens ADD COLUMN ram_free_mb  int;
ALTER TABLE screens ADD COLUMN ram_total_mb int;
ALTER TABLE screens ADD COLUMN cpu_pct      int;      -- player app CPU share
ALTER TABLE screens ADD COLUMN wifi_rssi    int;      -- dBm; NULL on ethernet
ALTER TABLE screens ADD COLUMN uptime_s     bigint;   -- device uptime
ALTER TABLE screens ADD COLUMN orientation  int NOT NULL DEFAULT 0
  CHECK (orientation IN (0, 90, 180, 270));
