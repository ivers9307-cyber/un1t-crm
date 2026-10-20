-- 760 — LIEU.1: time-in-lieu ledger for Sunday and public-holiday work, and
-- the heartbeat row of the nightly cron that fills it.
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- The Organisation of Working Time Act 1997 (s.14 Sunday work, s.21 public
-- holidays) requires an employee who works a Sunday to be compensated, and one
-- who works a public holiday to receive one of four benefits. Until now the
-- CRM recorded neither: bank-holidays.js was read only to avoid charging
-- annual leave for a bank holiday inside a holiday request (HOLIDAYLEAVE.1),
-- and every rostered hour was priced the same whatever the day. The WRC
-- inspection of 21 Oct 2026 asked for the record.
--
-- THE RULE (Richard, 20 Oct 2026). FTE employees only (profiles.employment_type
-- = 'fte'; a contractor is paid per hour and gets neither):
--   • a Sunday worked earns TIME IN LIEU at time and a third: shift hours ×
--     locations.settings.payroll.sunday_multiplier (default 4/3), not a pay
--     premium;
--   • a public holiday worked (the studio's country's calendar in
--     src/lib/bank-holidays.js; Ireland for every UN1T studio) earns base time
--     in lieu: shift hours × 1;
--   • a public holiday that falls on a Sunday earns the greater of the two,
--     once (source 'public_holiday_worked', the Sunday multiplier).
-- Lieu time is TAKEN by a manager recording it against the ledger with a note
-- (source 'taken', negative hours), and a manager may add a manual credit with
-- a note (source 'manual'). The balance is the signed sum.
--
-- ===========================================================================
-- THE TABLE
-- ===========================================================================
-- One row per credit or debit, in HOURS (the roster's paid window, shiftHours,
-- the same figure as the Staff Hours report and the WRC pack). An automatic
-- row points at the shift assignment it came from, and shift_assignment_id is
-- UNIQUE, so the nightly sweep can run as often as it likes and a shift is
-- credited exactly once; two shifts on one Sunday are two credits (the person
-- worked both). The FK is ON DELETE SET NULL: a credit survives the loss of
-- its assignment (the hours were worked), and nothing can re-credit an
-- assignment that no longer exists. profile_id cascades like every other
-- profiles child (a profile is never deleted: mig 622 tombstones).
--
-- CLOSED TO EVERY CLIENT SESSION (mig 677's default for a new relation, stated
-- so the file means the same on a database whose defaults differ): RLS on, no
-- policy, no anon/authenticated privilege. Every read and write is a
-- service-role route (/api/schedule/allowances, /api/schedule/allowances/lieu,
-- the WRC pack, the Staff Cost report) or the nightly cron
-- (/api/cron/lieu-credits, src/lib/lieu-credits.js). The ledger holds no
-- secret column; `note` is free text a manager wrote.
--
-- ===========================================================================
-- THE HEARTBEAT
-- ===========================================================================
-- /api/cron/lieu-credits runs nightly (vercel.json, 03:40 UTC) and sweeps the
-- last 14 days of completed shifts at every studio. Daily cron sizing, as
-- mig 601 (extend-roster-horizon): a missed night plus half a day before it
-- pages. Born healthy. APPLY RIGHT AFTER THE LIEU.1 CODE DEPLOYS (or re-run
-- then): a row seeded before the route is live goes stale after 36 hours.
-- Before the table exists the route cannot run at all, so this file is the
-- one to apply BEFORE the merge; the heartbeat row is re-armed by a re-run
-- (ON CONFLICT DO UPDATE) if the deploy is slower.
--
-- ROLLBACK (forward-only repo; a NEW migration):
--   DROP TABLE public.staff_lieu_credits;
--   DELETE FROM public.cron_heartbeats WHERE name = 'lieu-credits';
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.staff_lieu_credits (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  location_id         uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  source              text        NOT NULL CHECK (source IN ('sunday_worked', 'public_holiday_worked', 'manual', 'taken')),
  shift_assignment_id uuid        REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
  credit_date         date        NOT NULL,
  hours               numeric(7,2) NOT NULL,
  worked_hours        numeric(7,2),
  multiplier          numeric(6,4),
  holiday_name        text,
  note                text,
  created_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- a credit is positive, lieu taken is negative, and nothing is zero
  CONSTRAINT staff_lieu_credits_hours_sign CHECK (
    (source = 'taken' AND hours < 0) OR (source <> 'taken' AND hours > 0)
  ),
  -- a manager's entry carries a note; an automatic one carries its shift
  CONSTRAINT staff_lieu_credits_note_or_shift CHECK (
    (source IN ('manual', 'taken') AND length(btrim(coalesce(note, ''))) > 0)
    OR (source IN ('sunday_worked', 'public_holiday_worked') AND shift_assignment_id IS NOT NULL)
  )
);

-- One automatic credit per shift assignment. NULLs are distinct, so manual and
-- taken rows (no assignment) never collide; ON CONFLICT (shift_assignment_id)
-- DO NOTHING infers this index.
CREATE UNIQUE INDEX IF NOT EXISTS staff_lieu_credits_assignment_unique
  ON public.staff_lieu_credits (shift_assignment_id);
CREATE INDEX IF NOT EXISTS staff_lieu_credits_profile_date
  ON public.staff_lieu_credits (profile_id, credit_date);
CREATE INDEX IF NOT EXISTS staff_lieu_credits_location_date
  ON public.staff_lieu_credits (location_id, credit_date);

ALTER TABLE public.staff_lieu_credits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_lieu_credits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_lieu_credits TO service_role;

COMMENT ON TABLE public.staff_lieu_credits IS
  'LIEU.1 (mig 760): time-in-lieu ledger in hours. FTE only. sunday_worked = shift hours × locations.settings.payroll.sunday_multiplier (default 4/3); public_holiday_worked = shift hours × 1 (× the Sunday multiplier when the holiday is a Sunday); manual = a manager''s credit with a note; taken = lieu time taken, negative, with a note. Balance = sum(hours). Written by /api/cron/lieu-credits (src/lib/lieu-credits.js) and /api/schedule/allowances/lieu; read by the allowances route, the Staff Cost report and the WRC pack. RLS on, no policy, no client privilege.';
COMMENT ON COLUMN public.staff_lieu_credits.shift_assignment_id IS
  'The assignment an automatic credit came from; UNIQUE, so the nightly sweep credits a shift once. NULL on manual and taken rows, and after the assignment is deleted.';
COMMENT ON COLUMN public.staff_lieu_credits.credit_date IS
  'The date worked (automatic rows) or the date the manager recorded (manual / taken). The allowance year is this date''s year.';

-- The nightly cron's heartbeat row (CLAUDE.md: a new cron needs its row in the
-- same migration, or stampHeartbeat writes to nothing).
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'lieu-credits',
  now(),
  86400,
  43200,
  'LIEU.1 — nightly (03:40 UTC) sweep (src/lib/lieu-credits.js runLieuCreditSweep) that credits time in lieu for every COMPLETED, non-cancelled FTE shift on a Sunday or a public holiday (bank-holidays.js, the studio''s country) in the last 14 days, once per shift assignment (unique index). Stamps only when the sweep read every studio: a studio whose shift read failed is counted in last_outcome.failed and the row is NOT stamped when every studio failed or the locations read failed. A night with nothing to credit is healthy. last_outcome carries { locations, candidates, inserted, skipped_existing, failed }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- Self-check against the catalog (mig 153's lesson: never the migration text).
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_lieu_credits'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_lieu_credits')
     OR has_any_column_privilege('anon', 'public.staff_lieu_credits', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.staff_lieu_credits', 'SELECT')
     OR has_any_column_privilege('anon', 'public.staff_lieu_credits', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.staff_lieu_credits', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.staff_lieu_credits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.staff_lieu_credits', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.staff_lieu_credits', 'INSERT') THEN
    RAISE EXCEPTION 'mig 760: staff_lieu_credits must have RLS on, no policy, and no client privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'staff_lieu_credits'
                   AND indexname = 'staff_lieu_credits_assignment_unique' AND indexdef ILIKE 'CREATE UNIQUE INDEX%') THEN
    RAISE EXCEPTION 'mig 760: staff_lieu_credits_assignment_unique is missing or not unique';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cron_heartbeats
                  WHERE name = 'lieu-credits' AND expected_interval_seconds = 86400 AND grace_seconds = 43200) THEN
    RAISE EXCEPTION 'mig 760: cron_heartbeats row lieu-credits did not end up on 86400 + 43200';
  END IF;
  RAISE NOTICE 'mig 760: staff_lieu_credits created (service role only); heartbeat lieu-credits seeded.';
END $$;

COMMIT;
