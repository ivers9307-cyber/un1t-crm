-- LEAVE.2 — time off: record who filed a request on someone's behalf, and stop
-- the approval trigger inventing allowances.
--
-- 1. time_off_requests.created_by — a manager can now record leave for a
--    coach who phones in sick (POST /api/schedule/time-off with profile_id).
--    NULL means the person filed it themselves (every row before this).
--    The on-behalf path is the ONLY writer, so self-filed requests keep
--    working if the code deploys first; the on-behalf path fails until this
--    column exists. Apply before merging.
--
-- 2. update_holiday_allowance() — the mig 011 trigger created the first
--    allowance row for a year with a hard-coded 20 days, and did so for
--    contractors too (one approved contractor holiday produced a 20-day
--    allowance, row 60bc7f5c-1527-4950-a6a7-c814162ed2d5, left in place — the
--    owner's call). It now seeds from profile_compensation.annual_leave_entitlement
--    (20 only when that is null) and creates nothing for a contractor. The
--    decrement branch is unchanged. The API already pre-seeds the row and
--    refuses contractor leave types, so this is defence in depth for any
--    other writer. Existing allowance rows are not changed.
--
-- Pending-request expiry is NOT stored: it is derived at read time
-- (shared/time-off.js isExpiredPendingRequest), so no status value, CHECK
-- change or cron is needed.

ALTER TABLE public.time_off_requests
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.time_off_requests.created_by IS
  'LEAVE.2 (mig 616) — the approver who recorded this request on the person''s behalf. NULL = filed by the person themselves.';

-- Covering index for the FK (advisor unindexed_foreign_keys).
CREATE INDEX IF NOT EXISTS time_off_requests_created_by_idx
  ON public.time_off_requests (created_by)
  WHERE created_by IS NOT NULL;

CREATE OR REPLACE FUNCTION public.update_holiday_allowance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  v_entitlement numeric;
BEGIN
  IF NEW.type = 'holiday' AND NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    -- Contractors have no holiday allowance.
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = NEW.profile_id AND p.employment_type = 'contractor'
    ) THEN
      SELECT pc.annual_leave_entitlement INTO v_entitlement
      FROM public.profile_compensation pc
      WHERE pc.profile_id = NEW.profile_id;

      INSERT INTO public.staff_allowances (profile_id, year, total_days, used_days)
      VALUES (NEW.profile_id, EXTRACT(YEAR FROM NEW.start_date)::INT, COALESCE(v_entitlement, 20), NEW.total_days)
      ON CONFLICT (profile_id, year)
      DO UPDATE SET
        used_days = public.staff_allowances.used_days + NEW.total_days,
        updated_at = NOW();
    END IF;
  END IF;

  IF NEW.type = 'holiday' AND OLD.status = 'approved' AND NEW.status IN ('cancelled', 'rejected') THEN
    UPDATE public.staff_allowances
    SET used_days = GREATEST(0, used_days - OLD.total_days),
        updated_at = NOW()
    WHERE profile_id = OLD.profile_id
    AND year = EXTRACT(YEAR FROM OLD.start_date)::INT;
  END IF;

  RETURN NEW;
END;
$function$;
