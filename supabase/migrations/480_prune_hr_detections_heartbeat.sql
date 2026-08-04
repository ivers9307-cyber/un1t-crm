-- 480: H1c — hr_detections / hr_detection_visits retention (30 days, hard delete).
--
-- Backing migration for /api/cron/prune-hr-detections. See
-- src/lib/hr-detections-retention.js for the window + cap constants
-- (HR_DETECTIONS_RETENTION_DAYS = 30, batch 500, <=5000 deletes per table per
-- run) and the pure cutoff / safety-guard logic.
--
-- WHAT THE CRON DOES (recap): the mig 292 detections registry logs EVERY HR
-- strap the bridge sees at a location — passers-by included — with BLE device
-- names attached, which makes an indefinite log GDPR-adjacent. Weekly, the
-- cron deletes hr_detection_visits whose last_sample_at, and hr_detections
-- whose last_seen_at, are older than 30 days. Unlike prune-hr-samples
-- (DECISION #3 — a downsample), this IS an erasure: detections are ambient
-- observation, not a member's workout record. Linked members' session data
-- (heart_rate_sessions / hr_samples) is untouched.
--
-- No schema change: the prune scans run weekly against tables that this same
-- cron keeps at ~30 days of rows, so a dedicated age-column index isn't
-- warranted (contrast mig 353, which indexed a scan over an ever-growing
-- multi-year table).

-- ── cron_heartbeats seed ─────────────────────────────────────────
--
-- stampHeartbeat() does an UPDATE-only against cron_heartbeats; if the row
-- doesn't exist the stamp silently matches 0 rows and /api/cron/health-check
-- has nothing to evaluate (see mig 171). Seed it here.
--
-- Weekly cron (Sunday 02:30 UTC — off-peak, offset from prune-hr-samples at
-- 02:00; see vercel.json). expected_interval = 7 days; grace = 2 days (allows
-- one skipped weekly tick — e.g. a Vercel deploy-skip collision — before the
-- health check flags it stale).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('prune-hr-detections', 604800, 172800,
   'H1c — deletes hr_detections (last_seen_at) + hr_detection_visits (last_sample_at) older than 30 days; ambient BLE strap sightings, GDPR-adjacent. Weekly Sun 02:30 UTC, off-peak. Bounded per run (batches of 500, <=5000 deletes per table); first-run backlog drains over a few weeks. 172800s grace = 2 days = one missed weekly tick tolerated.')
ON CONFLICT (name) DO NOTHING;
