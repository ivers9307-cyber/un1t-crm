-- 601 — ROSTER-FIX.5: horizon-cron heartbeat + scheduled-report schedule fixes.
--
-- WHY (1) — the horizon cron
-- ──────────────────────────
-- `/api/cron/extend-roster-horizon` (nightly, 03:20 UTC) replaces the old
-- lazy extend; the full story is in src/lib/roster-horizon.js. Per CLAUDE.md
-- a new cron needs its cron_heartbeats row in the same migration, or
-- stampHeartbeat() writes to nothing and the cron is invisible to Sentinel.
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
-- were written Monday-first, so they are rotated once here to match.
--
-- REPLAYING THIS MIGRATION IS A NO-OP. The rotation is guarded by the column
-- comment it sets: the comment IS the "already rotated" marker, and both are
-- written inside one DO block, so they are set in the same transaction and
-- can never disagree. A second run finds the marker and does nothing. This
-- file used to carry a bare UPDATE that rotated the column every time it ran
-- — a re-run (a replay, a restore, a hand-run against a second environment)
-- silently moved every schedule another day.

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
  'ROSTER-FIX.5 — nightly (03:20 UTC) sweep that keeps 8 weeks of shift_blocks materialised ahead of this week Monday for every active shift_template. Idempotent (unique key on location_id,template_id,block_date): re-running inserts only what is missing. New blocks landing inside an already-published roster are tagged with its roster_id. Stamps only when the sweep actually advanced the horizon: a template query that fails throws and stamps nothing, and a sweep in which EVERY template failed one by one is a 500 with no stamp (a green heartbeat over a horizon that had stopped moving is the exact failure this row exists to catch). A PARTIAL failure still stamps, since the horizon did advance for the rest of the estate; those templates are logged and counted in last_outcome.failed, which is where to look first. last_outcome carries { templates, inserted, skipped, failed }.'
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
-- (0=Sun..6=Sat).
--
-- EVERY non-null row is rotated, not just weekly/fortnightly ones. The old
-- `frequency IN ('weekly','fortnightly')` guard assumed nothing else reads the
-- column, but ScheduleReporting.jsx renders it on `sr.day_of_week != null`
-- alone (line ~419) — so a 'once' or 'monthly' row that still carries a
-- weekday from an earlier edit would have been left Monday-first and rendered
-- one day wrong forever, in a spot nobody would think to look. A stale value
-- on a row whose frequency ignores it is harmless either way; a value the UI
-- shows must be in the one convention the code agrees on.
--
-- The marker comment is set INSIDE the block, after the UPDATE, so the
-- rotation and the "already rotated" flag commit together.
DO $$
DECLARE
  marker CONSTANT text :=
    'JS weekday: 0=Sunday .. 6=Saturday. Matches Date.getDay(), which calculateNextRun() has always used. The UI presents a Monday-first list and converts (see src/lib/report-schedule-days.js).';
BEGIN
  IF col_description(
       'public.scheduled_reports'::regclass,
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.scheduled_reports'::regclass
           AND attname = 'day_of_week')
     ) IS DISTINCT FROM marker THEN

    UPDATE public.scheduled_reports
       SET day_of_week = (day_of_week + 1) % 7,
           updated_at = now()
     WHERE day_of_week IS NOT NULL;

    EXECUTE format(
      'COMMENT ON COLUMN public.scheduled_reports.day_of_week IS %L', marker
    );
  END IF;
END $$;
