-- ============================================================
-- 125: staff_required — capacity model for demand-vs-supply
-- planning on the studio overview strip.
--
-- Adds the same column to TWO tables that share the same
-- semantics:
--
--   race_events.staff_required     — multi-kind events feature
--                                    (race / workshop / seminar /
--                                    open_day / masterclass).
--                                    Operator-set per event.
--
--   event_types.staff_required     — Calendly booking templates
--                                    (the bookable surfaces). Demand
--                                    is COMMITMENT-based not
--                                    utilization-based: if PT is
--                                    bookable Mon 9-17 we need a
--                                    coach rostered Mon 9-17 even
--                                    with zero confirmed bookings,
--                                    so a last-minute booker finds
--                                    coverage.
--
-- 0 is a meaningful value: "bookable but doesn't add to demand
-- because coverage comes from another role" (e.g. consultations
-- handled by the same coach that's already covering PT bookings).
-- 50 ceiling is defensive — no realistic event needs more.
--
-- DEFAULT 1 backfills every existing row in one statement; operator
-- can edit afterwards. The studio overview classifier (mig 125's
-- companion src/lib/schedule-overview.js) reads these columns to
-- compute per-day demand:
--
--   day_demand = SUM(events_today.staff_required)
--              + SUM(event_types_with_window_today.staff_required)
--
--   day_supply = staff_scheduled_today - staff_on_leave_today
--
--   classification:
--     red   if demand > 0 AND supply == 0
--     amber if supply < demand
--     green otherwise
-- ============================================================

BEGIN;

-- ── race_events ────────────────────────────────────────────────

ALTER TABLE public.race_events
  ADD COLUMN IF NOT EXISTS staff_required INT NOT NULL DEFAULT 1;

ALTER TABLE public.race_events
  DROP CONSTRAINT IF EXISTS race_events_staff_required_check;

ALTER TABLE public.race_events
  ADD CONSTRAINT race_events_staff_required_check
  CHECK (staff_required BETWEEN 0 AND 50);

COMMENT ON COLUMN public.race_events.staff_required IS
  'How many staff are needed at this event. Operator-set during creation; default per kind on the form (race=4, workshop=1, seminar=1, open_day=2, masterclass=1). Drives the studio overview demand-vs-supply classifier on /schedule. 0 = bookable but doesn''t add to demand (covered by another role). Mig 125.';

-- ── event_types ────────────────────────────────────────────────

ALTER TABLE public.event_types
  ADD COLUMN IF NOT EXISTS staff_required INT NOT NULL DEFAULT 1;

ALTER TABLE public.event_types
  DROP CONSTRAINT IF EXISTS event_types_staff_required_check;

ALTER TABLE public.event_types
  ADD CONSTRAINT event_types_staff_required_check
  CHECK (staff_required BETWEEN 0 AND 50);

COMMENT ON COLUMN public.event_types.staff_required IS
  'How many staff are needed to keep this booking type bookable. Commitment-based: if availability exists for a day, this many staff must be rostered to cover it (regardless of actual booking count). Set 0 for "covered by another role" (e.g. consultations handled by the PT coach already on shift). Drives the studio overview classifier on /schedule. Mig 125.';

COMMIT;
