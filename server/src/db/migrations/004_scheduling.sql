-- Phase 2: scheduling / dayparting on assignments.
-- All fields NULL = "always" (the default/fallback assignment).
ALTER TABLE assignments
  ADD COLUMN priority     int NOT NULL DEFAULT 0,
  ADD COLUMN days_of_week int[],   -- 0=Sunday … 6=Saturday; NULL = every day
  ADD COLUMN start_time   time,    -- daypart window start (screen-local); NULL = all day
  ADD COLUMN end_time     time,    -- window end; if before start, window crosses midnight
  ADD COLUMN start_date   date,    -- campaign bounds; NULL = unbounded
  ADD COLUMN end_date     date;

-- Offline alert bookkeeping: set when an offline email was sent, cleared on recovery.
ALTER TABLE screens ADD COLUMN offline_alerted_at timestamptz;
