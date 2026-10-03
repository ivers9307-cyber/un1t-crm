-- 609 — ARRIVAL.1: a phone arrival is attendance evidence, not the paid window.
--
-- WHY
-- ───
-- Since GEO-ATT.4 (live 2026-07-31) the geofence check-in wrote the arrival
-- time into shift_assignments.start_time_override, the column mig 099 defines
-- as the MANAGER-set partial-shift paid window (decision D3, 2026-09-09).
-- Every hours/cost reader bills that column first (effectiveOverride,
-- payroll.shiftHours, the publish gate, week-cost, contractor spend, the staff
-- reports), so arrivals silently moved paid hours: the 16 Sep review counted
-- 95 stamps, +73.6 FTE hours, and all 12.6 "overtime" hours in the August
-- staff_cost report. Arrival now has its own columns.
--
-- This migration only ADDS columns and is safe to apply before the ARRIVAL.1
-- code deploys (old code never reads them). The clean-up of existing stamps
-- is mig 610, applied AFTER deploy.
--
-- REPLAY: ADD COLUMN IF NOT EXISTS; the named CHECK is dropped and re-added.

ALTER TABLE public.shift_assignments
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_source text;

ALTER TABLE public.shift_assignments
  DROP CONSTRAINT IF EXISTS shift_assignments_arrival_source_check;
ALTER TABLE public.shift_assignments
  ADD CONSTRAINT shift_assignments_arrival_source_check
  CHECK (arrival_source IS NULL OR arrival_source IN ('geofence', 'manual'));

COMMENT ON COLUMN public.shift_assignments.arrived_at IS
  'ARRIVAL.1 (mig 609): when the coach arrived for this shift (attendance evidence). NEVER a paid-window input; the paid window is start_time_override/end_time_override (manager-set, mig 099) falling back to the block.';
COMMENT ON COLUMN public.shift_assignments.arrival_source IS
  'ARRIVAL.1 (mig 609): what recorded arrived_at: geofence (phone check-in) or manual.';
