-- Recurrence interval: 1 = every week, 2 = every 2 weeks (bi-weekly), etc.
-- Anchored to start_date (the UI sets one whenever interval > 1).
ALTER TABLE assignments ADD COLUMN week_interval int NOT NULL DEFAULT 1
  CHECK (week_interval BETWEEN 1 AND 8);
