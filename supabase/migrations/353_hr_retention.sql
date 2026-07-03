-- DECISION #3 — hr_samples retention (12 months raw, then downsample).
--
-- Backing migration for /api/cron/prune-hr-samples. See src/lib/hr-retention.js
-- for the retention window + bucket constants (HR_RAW_RETENTION_MONTHS = 12,
-- HR_DOWNSAMPLE_BUCKET_SECONDS = 30) and the pure downsample decision logic.
--
-- WHAT THE CRON DOES (recap): for hr_samples older than 12 months (by
-- recorded_at) it keeps ONE representative sample per session per 30-second
-- bucket and deletes the intra-bucket rest — a ~30× volume cut that preserves
-- the HR-trace shape for old reports / share links. The per-session SUMMARY
-- (zones_seconds, effort_points, avg/peak bpm, calories) lives on
-- heart_rate_sessions and is KEPT FOREVER; only the raw high-frequency samples
-- are reduced. This is a DOWNSAMPLE, not an erasure.
--
-- INDEX NOTES:
--   * The per-session sample scan (WHERE session_id = $1 AND recorded_at <
--     cutoff) is already served by the hr_samples PRIMARY KEY
--     (session_id, recorded_at) from mig 110 — no new hr_samples index needed.
--     (idx_hr_samples_recorded ON (recorded_at) from mig 110 also exists.)
--   * The candidate scan anchors on heart_rate_sessions.started_at (one row per
--     workout — far cheaper than scanning hr_samples for distinct session_ids).
--     started_at only appears as a SECONDARY column in the existing indexes
--     (idx_hr_sessions_contact_started, idx_hr_sessions_location), so a global
--     "WHERE started_at < cutoff ORDER BY started_at" can't use them. Add a
--     dedicated index so the weekly candidate scan is index-backed.
CREATE INDEX IF NOT EXISTS idx_hr_sessions_started_at
  ON public.heart_rate_sessions (started_at);

-- ── cron_heartbeats seed ─────────────────────────────────────────
--
-- stampHeartbeat() does an UPDATE-only against cron_heartbeats; if the row
-- doesn't exist the stamp silently matches 0 rows and /api/cron/health-check
-- has nothing to evaluate (see mig 171). Seed it here.
--
-- Weekly cron (Sunday 02:00 UTC — off-peak; see vercel.json). expected_interval
-- = 7 days; grace = 2 days (allows one skipped weekly tick — e.g. a Vercel
-- deploy-skip collision — before the health check flags it stale).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('prune-hr-samples', 604800, 172800,
   'DECISION #3 — downsamples hr_samples older than 12 months to one sample per session per 30s bucket. Weekly Sun 02:00 UTC, off-peak. Bounded per run (<=200 sessions / <=50k deletes); backlog drains over several weeks. 172800s grace = 2 days = one missed weekly tick tolerated.')
ON CONFLICT (name) DO NOTHING;
