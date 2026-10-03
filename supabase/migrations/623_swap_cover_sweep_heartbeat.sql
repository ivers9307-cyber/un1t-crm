-- 623 — SWAPHB.1: a heartbeat row of its own for the swap cover sweep.
--
-- WHY
-- ───
-- COVERLOOP.1 (#1733) added the swap cover sweep as a second arm of the
-- `*/15` cron at /api/cron/checklist-sweep. When that arm throws or reports
-- errors the response carries `swap_sweep_failed: 1` and the outcome is
-- written into the 'checklist-sweep' row's last_outcome, but that shared row
-- is still stamped, and /api/cron/health-check reads only cron_health.is_stale
-- (mig 053), never last_outcome. So a swap arm failing on EVERY tick paged
-- nobody: open swaps stop being re-pushed at T-48h/T-12h, started swaps stop
-- being closed, and the only trace is a JSON field in a row nobody reads.
-- This estate has already had a silent 24-day outage of exactly that shape
-- (the sequence_enrollments.created_at story in CLAUDE.md).
--
-- The route now stamps 'swap-cover-sweep' ONLY when the arm ran and
-- swap_sweep_failed is 0. stampHeartbeat() is UPDATE-only, so without this
-- row that stamp matches 0 rows and is a logged no-op:
--
--   APPLY THIS MIGRATION BEFORE THE CODE DEPLOYS.
--
-- No code change is needed in the health-check: cron_health is an unfiltered
-- SELECT over cron_heartbeats, so the row is picked up the moment it exists.
--
-- CADENCE
-- ───────
-- Vercel cron */15 → expected_interval_seconds = 900, the same as the
-- 'checklist-sweep' row it rides with (mig 406). grace_seconds is 1800, NOT
-- 406's 900, on purpose. This stamp is conditional on a clean arm, and the
-- arm counts an error for any single swap it could not process ("the next
-- tick retries it"), so one transient bad tick is an expected event: with
-- 900+900 the row would sit exactly on the stale boundary when the next good
-- tick lands, and a monitor ping in that second would page for a blip. With
-- 900+1800 one bad tick can never page and an arm that stays broken pages
-- within 45 minutes.
--
-- A quiet-hours tick (outside 07:00-22:00 studio time) returns normally with
-- errors: 0 and stamps, so the row does not go stale overnight.
--
-- Born healthy (last_ok_at = now()) so it cannot page before the first real
-- tick. That gives 45 minutes between applying this and the code being live;
-- if the deploy is held up longer, re-run this file: replaying it is safe,
-- it only refreshes the row and re-arms last_ok_at.

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'swap-cover-sweep',
  now(),
  900,
  1800,
  'SWAPHB.1 — the swap cover arm (src/lib/swap-cover-server.js runSwapCoverSweep, COVERLOOP.1) of the */15 Vercel cron /api/cron/checklist-sweep. It has no route or vercel.json entry of its own. Stamped ONLY when the arm ran and swap_sweep_failed is 0 (it did not throw and reported errors: 0), independently of the checklist arm: a checklist 500 still stamps this row, and a failing swap arm still stamps checklist-sweep. Quiet-hours ticks stamp. STALE therefore means the arm has thrown or reported errors on every tick for 45 minutes: look at last_outcome.swap_cover / swap_sweep_failed on the checklist-sweep row and at the swap-cover logError lines. last_outcome carries the arm''s counts { open, nudged, expired, skipped, quiet, announced, errors }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;
