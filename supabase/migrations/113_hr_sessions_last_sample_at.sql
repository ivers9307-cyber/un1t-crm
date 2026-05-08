-- 113_hr_sessions_last_sample_at.sql
--
-- Live coach view needs to know whether a session's strap is
-- actively broadcasting or has gone quiet. Adding a last_sample_at
-- column updated by the bridge ingestion path on every insert
-- batch. The live view reads it to flag stale sessions ("strap
-- silent for >2min — maybe member left").
--
-- Could be derived from MAX(hr_samples.recorded_at) on the fly,
-- but with 30 attendees × every 2s polling that's 30 SQL aggregates
-- per poll — wasteful when a single column update at insert time
-- gives the same answer for free.

ALTER TABLE public.heart_rate_sessions
  ADD COLUMN IF NOT EXISTS last_sample_at timestamptz;

-- Index for the live view's "open sessions, recent activity" query.
-- WHERE ended_at IS NULL stays the predicate; we order by
-- last_sample_at DESC to surface the freshest streams first.
CREATE INDEX IF NOT EXISTS idx_hr_sessions_live_active
  ON public.heart_rate_sessions(location_id, last_sample_at DESC NULLS LAST)
  WHERE ended_at IS NULL;
