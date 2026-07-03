-- HR live running aggregate (audit W2/#11).
--
-- The public live-TV board (/api/public/live/[locationId] via
-- src/lib/live-board.js buildLiveBoardPayload) polls every 2s. It used to page
-- EVERY hr_sample for EVERY open session on each poll and re-run summariseSession
-- over the whole class — O(minutes × attendees) rows re-scanned per poll. This
-- moves that aggregate onto the session row, maintained INCREMENTALLY at ingest
-- (src/lib/bridge-samples.js insertHrSamples → applyBatchToRunningSummary), so
-- the live route reads a single row per session instead of scanning samples.
--
-- The AUTHORITATIVE columns already exist on heart_rate_sessions and are the
-- render source both live (now) and finalised: zones_seconds (jsonb),
-- effort_points, peak_hr_bpm, avg_hr_bpm. During a live session they hold the
-- running incremental value; endSession (src/lib/live-class.js) still does the
-- full summariseSession recompute at class end and OVERWRITES them — that stays
-- the backstop that corrects any residual live lag (the ≤5s pending-last-sample
-- tail the incremental deliberately leaves un-counted).
--
-- NEW here: the extra running-fold STATE the incremental needs and the live
-- render columns don't already carry:
--   live_sum_bpm       Σ bpm over all samples so far          (→ avg = round(sum/count))
--   live_sample_count  count of samples folded so far
--   live_last_bpm      the pending last sample's bpm          (its gap is attributed
--   live_last_at       the pending last sample's recorded_at   when the NEXT batch lands)
--
-- All nullable / default null. No backfill: an open session with null state is
-- treated as zeroes and repopulates on its next ingest batch; the live route
-- tolerates nulls (normaliseRunningState coerces them to an empty summary).
-- last_sample_at is left as-is (it already tracks max recorded_at for the stale
-- flag) — we need the pending sample's BPM too, which it can't carry, hence
-- live_last_bpm/live_last_at as a dedicated pair.

alter table public.heart_rate_sessions
  add column if not exists live_sum_bpm       bigint,
  add column if not exists live_sample_count  integer,
  add column if not exists live_last_bpm      smallint,
  add column if not exists live_last_at       timestamptz;

comment on column public.heart_rate_sessions.live_sum_bpm is
  'Running Σ bpm of folded samples (avg = round(live_sum_bpm/live_sample_count)); live-board incremental aggregate (mig 354). Null until first batch. endSession recomputes avg_hr_bpm authoritatively at class end.';
comment on column public.heart_rate_sessions.live_sample_count is
  'Running count of folded samples for the live-board incremental average (mig 354). Null until first batch.';
comment on column public.heart_rate_sessions.live_last_bpm is
  'BPM of the pending (not-yet-gap-attributed) last sample; live-board incremental fold state (mig 354). Its gap is attributed when the next ingest batch arrives.';
comment on column public.heart_rate_sessions.live_last_at is
  'recorded_at of the pending last sample; live-board incremental fold state (mig 354). Paired with live_last_bpm.';
