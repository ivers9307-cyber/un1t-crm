-- PIPELINE5.3 — 7-day attendance count column.
--
-- The classifier (pipeline-classifier.js) uses ≥2 classes in last
-- 7 days as the trigger for Hot Conversion. The existing
-- total_attended_30d wasn't tight enough — someone who took 2
-- classes 25 days ago shouldn't be a "hot" right now.
--
-- computeBookingAggregates (glofox-sync.js) now writes both 30d
-- and 7d windows on every sync. New contacts default to 0 (no
-- bookings). Existing 8k contacts get backfilled on the next
-- daily-sync cron pass — until then they're 0, which means none
-- of them qualify as Hot Conversion via this signal alone (the
-- credits threshold still works).

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS total_attended_7d INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN contacts.total_attended_7d IS
  'PIPELINE5.3: Glofox bookings attended in last 7 days. Drives the Hot Conversion classifier signal (≥2 in 7d → hot). Written by computeBookingAggregates on every Glofox sync.';
