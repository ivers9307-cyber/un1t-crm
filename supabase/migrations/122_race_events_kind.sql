-- ============================================================
-- 122: race_events.kind — turn the table into a multi-kind events
-- entity (race + workshop + seminar + open_day + masterclass)
--
-- Background: mig 082 introduced race_events as a first-class
-- standalone entity for race occurrences. As the product evolved,
-- the same shape (per-location, scheduled date, registration
-- window, capacity, signup widget, per-seat name+email capture
-- via team_members) turns out to fit workshops, seminars, open
-- days and masterclasses too. Rather than build a parallel
-- "workshops" stack, we extend race_events with a `kind`
-- discriminator and let app code conditionally show / hide the
-- race-specific bits.
--
-- Why this is a single-column migration (and not a rename):
--   - Renaming race_events → events would cascade through every
--     RLS policy, every FK in race_registrations / race_payments /
--     race_waves / race_members / race_orders_events_tags / race_tv_logos,
--     every PostgREST embed, every sequence-step source_type
--     reference. Per the architecture decision (URL + UI rename
--     only, keep DB names), the table name stays.
--   - DB consumers that assume "every row is a race" (race-day
--     control panel, race-timing cron, TV display) get gated at
--     the app layer on `kind = 'race'`. RLS unchanged — same
--     location-scoping rules apply to all kinds.
--
-- Backfill: existing rows are races by definition (the table
-- only ever held races until now) so DEFAULT 'race' on a NOT NULL
-- column does the backfill in the same statement, no separate
-- UPDATE needed.
--
-- Enum representation: TEXT + CHECK rather than native PG ENUM,
-- matching the codebase convention (mig 120 staff_attendance_events.
-- source / match_outcome, mig 082 race_registrations.status, etc.).
-- Easier to extend — adding a value is one line in this CHECK
-- definition, no ALTER TYPE dance.
-- ============================================================

BEGIN;

ALTER TABLE public.race_events
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'race';

ALTER TABLE public.race_events
  DROP CONSTRAINT IF EXISTS race_events_kind_check;

ALTER TABLE public.race_events
  ADD CONSTRAINT race_events_kind_check
  CHECK (kind IN ('race', 'workshop', 'seminar', 'open_day', 'masterclass'));

COMMENT ON COLUMN public.race_events.kind IS
  'Discriminator for what type of event this is. ''race'' = the original Hyrox-sim shape (waves, team-name required, race-day control panel, TV display board, race-timing cron). ''workshop'' / ''seminar'' / ''open_day'' / ''masterclass'' = single-time-slot events with per-seat name+email capture but no team-name requirement and no race-day timing. App code gates race-specific UI / cron / routes on kind=''race''. Backfilled to ''race'' on add (mig 122) — every pre-existing row in this table predates the multi-kind extension and is a race by definition.';

-- Index supports the "Events" index page filtering by kind within
-- a location (e.g. "show me upcoming workshops at Stillorgan").
-- Partial WHERE active mirrors idx_race_events_active so this
-- doesn't carry historical inactive rows.
CREATE INDEX IF NOT EXISTS idx_race_events_kind_active
  ON public.race_events (location_id, kind, race_date)
  WHERE active;

COMMIT;
