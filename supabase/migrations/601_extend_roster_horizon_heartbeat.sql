-- 601 — ROSTER-FIX.5: horizon-cron heartbeat + scheduled-report schedule fixes.
--
-- WHY (1) — the horizon cron
-- ──────────────────────────
-- shift_blocks were only ever materialised on demand: when a template's
-- days_of_week was saved, or when an operator scrolled the web calendar past
-- the 8-week window (`/api/schedule/blocks` GET lazy-extended). Nothing does
-- either on its own, and mobile does neither at all — so a location whose
-- manager had not opened the calendar recently simply had no blocks in the
-- coming weeks, and every roster surface read "empty" rather than "not
-- generated yet". `/api/cron/extend-roster-horizon` (nightly, 03:20 UTC) now
-- keeps 8 weeks in front of this week's Monday for every active template.
-- Per CLAUDE.md a new cron needs its cron_heartbeats row in the same
-- migration, or stampHeartbeat() writes to nothing and the cron is invisible
-- to Sentinel.
--
-- WHY (2) — scheduled_reports.frequency
-- ─────────────────────────────────────
-- Three definitions of "frequency" had drifted apart:
--   • this table's CHECK:  once | weekly | fortnightly | monthly
--   • the POST Zod enum:   once | daily  | weekly      | monthly
--   • the UI's dropdown:   weekly | fortnightly | monthly
-- So "Fortnightly" was offered in the UI and rejected by the API, while
-- "daily" was accepted by the API and rejected by this CHECK. ROSTER-FIX.5
-- makes all three agree on the full set; the CHECK is the half that needs a
-- migration (widening only — no existing row can violate it).
--
-- WHY (3) — day_of_week is a JS weekday
-- ─────────────────────────────────────
-- The column comment below used to say 0=Mon, but calculateNextRun() has
-- always done `(day_of_week - date.getDay() + 7) % 7`, which is JS's
-- convention (0=Sun). The UI wrote a Monday-first index into it, so every
-- weekly/fortnightly schedule fired one day early — a "Monday" report ran on
-- Sunday. ROSTER-FIX.5 settles on the JS convention (the one the arithmetic
-- already uses) and the UI now converts on the way in and out. Existing rows
-- were written Monday-first, so they are rotated once here to match; run this
-- migration exactly once (it is a rotation, not an idempotent set).

-- ============================================================
-- 1. Heartbeat for /api/cron/extend-roster-horizon
-- ============================================================
-- Daily cron: a missed day plus half a day before it pages, so a deploy
-- window or a slow night never cries wolf. Born healthy so it cannot page
-- before the first real tick.
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'extend-roster-horizon',
  now(),
  86400,
  43200,
  'ROSTER-FIX.5 — nightly (03:20 UTC) sweep that keeps 8 weeks of shift_blocks materialised ahead of this week Monday for every active shift_template. Idempotent (unique key on location_id,template_id,block_date): re-running inserts only what is missing. New blocks landing inside an already-published roster are tagged with its roster_id. Stamps only when the template sweep completed; a template that fails individually is logged and counted in last_outcome.failed without failing the tick. last_outcome carries { templates, inserted, skipped, failed }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- ============================================================
-- 2. scheduled_reports.frequency — allow 'daily'
-- ============================================================
ALTER TABLE public.scheduled_reports
  DROP CONSTRAINT IF EXISTS scheduled_reports_frequency_check;
ALTER TABLE public.scheduled_reports
  ADD CONSTRAINT scheduled_reports_frequency_check
  CHECK (frequency IN ('once', 'daily', 'weekly', 'fortnightly', 'monthly'));

-- ============================================================
-- 3. day_of_week — adopt the JS convention the code already uses
-- ============================================================
-- Rotate the stored Monday-first index (0=Mon..6=Sun) into JS's
-- (0=Sun..6=Sat). Only weekly/fortnightly rows use the column at all.
UPDATE public.scheduled_reports
   SET day_of_week = (day_of_week + 1) % 7,
       updated_at = now()
 WHERE day_of_week IS NOT NULL
   AND frequency IN ('weekly', 'fortnightly');

COMMENT ON COLUMN public.scheduled_reports.day_of_week IS
  'JS weekday: 0=Sunday .. 6=Saturday. Matches Date.getDay(), which calculateNextRun() has always used. The UI presents a Monday-first list and converts (see src/lib/report-schedule-days.js).';
