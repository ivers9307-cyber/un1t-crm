-- 344: CLASS-CLIMATE.1 (P0-8) — cancellation reconciliation for the schedule spine.
--
-- The spine (class_occurrences, mig 284) is a local mirror of the Glofox
-- timetable. Until now the sync only UPSERTED active events and silently
-- skipped inactive/private/deleted ones, so a class cancelled after a sync ran
-- left a STALE row behind — and resolveCurrentOccurrence / the class-climate
-- runner happily fired the studio AC (and HR class-linking) for a class that
-- isn't happening. That stale-spine cost is the exact thing the feature exists
-- to avoid.
--
-- Fix: an additive, nullable `cancelled_at` flag. syncOccurrencesForLocation
-- now reconciles the fetched window after a SUCCESSFUL fetch — stamping
-- cancelled_at on rows whose Glofox event vanished/went inactive, and clearing
-- it (back to NULL) on any event that came back active. Every "live/current/
-- booked" read filters `.is('cancelled_at', null)`. The flag is additive and
-- default-null, so existing rows read exactly as before until a sync runs.

BEGIN;

ALTER TABLE public.class_occurrences
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN public.class_occurrences.cancelled_at IS
  'When set, this occurrence was cancelled/removed from the Glofox timetable and must be excluded from live/current/booked reads (CLASS-CLIMATE.1, mig 344). Reconciled by syncOccurrencesForLocation after a successful fetch; cleared back to NULL if the event returns active.';

-- Partial index for the "live" reads (they filter cancelled_at IS NULL and
-- scope by location + starts_at). Complements idx_class_occurrences_loc_start.
CREATE INDEX IF NOT EXISTS idx_class_occurrences_live
  ON public.class_occurrences (location_id, starts_at)
  WHERE cancelled_at IS NULL;

COMMIT;
