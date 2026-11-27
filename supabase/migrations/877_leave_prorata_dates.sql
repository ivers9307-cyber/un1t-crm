-- LEAVEPRORATA.1 — pro-rate the holiday allowance by start and leaving date.
--
-- The allowance was the whole contract entitlement for every year, so a coach
-- who started on 1 September was shown 20 days for 2026 and a leaver kept the
-- full year on screen. Rule (Richard, 27 Nov 2026): entitlement × calendar
-- days employed in the year ÷ days in the year, to the nearest half day. A
-- whole year is the entitlement exactly. JS twin: src/lib/leave-prorata.js.
--
-- 1. profile_compensation.employment_start_date / employment_end_date: on the
--    owner/master-only pay table (mig 152), not profiles, which every staff
--    session can read: a leaving date is not for colleagues. Both optional;
--    unset means open on that side. The table's grants are table-level, so
--    the new columns inherit them (no column grant decision to make).
-- 2. public.prorated_leave_days(): the rule in SQL. Immutable, no table
--    access, so EXECUTE stays closed to client sessions (mig 667 default).
-- 3. update_holiday_allowance(): the trigger's fallback seed (a first
--    approved holiday with no allowance row) now seeds the pro-rated figure.
--    The API pre-seeds through ensureHolidayAllowanceRow, which applies the
--    same rule; this is the defence in depth mig 616 set up. Decrement branch
--    unchanged.
-- 4. Backfill: start date from the person's latest signed contract's
--    commencement_date (3 people on 27 Nov 2026), then this year's and
--    earlier saved allowances for those people recalculated (used days kept),
--    the same thing saving a start date in the staff editor does.

ALTER TABLE public.profile_compensation
  ADD COLUMN IF NOT EXISTS employment_start_date date,
  ADD COLUMN IF NOT EXISTS employment_end_date date;

ALTER TABLE public.profile_compensation
  DROP CONSTRAINT IF EXISTS profile_compensation_employment_dates_order;
ALTER TABLE public.profile_compensation
  ADD CONSTRAINT profile_compensation_employment_dates_order
  CHECK (employment_end_date IS NULL OR employment_start_date IS NULL OR employment_end_date >= employment_start_date);

COMMENT ON COLUMN public.profile_compensation.employment_start_date IS
  'LEAVEPRORATA.1 (mig 877) — first day of employment. Pro-rates the holiday allowance for that year. NULL = before any year we count.';
COMMENT ON COLUMN public.profile_compensation.employment_end_date IS
  'LEAVEPRORATA.1 (mig 877) — last day of employment (leaving date), inclusive. Pro-rates the holiday allowance for that year. NULL = not leaving.';

CREATE OR REPLACE FUNCTION public.prorated_leave_days(p_entitlement numeric, p_year int, p_start date, p_end date)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $function$
  WITH b AS (
    SELECT make_date(p_year, 1, 1) AS y0,
           make_date(p_year, 12, 31) AS y1
  ), d AS (
    SELECT (b.y1 - b.y0 + 1) AS len,
           GREATEST(0, (LEAST(b.y1, COALESCE(p_end, b.y1)) - GREATEST(b.y0, COALESCE(p_start, b.y0)) + 1)) AS employed
    FROM b
  )
  SELECT CASE
    WHEN p_entitlement IS NULL OR p_entitlement <= 0 THEN p_entitlement
    WHEN d.employed >= d.len THEN p_entitlement
    WHEN d.employed = 0 THEN 0
    ELSE round(p_entitlement * d.employed / d.len * 2) / 2
  END
  FROM d
$function$;

REVOKE ALL ON FUNCTION public.prorated_leave_days(numeric, int, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prorated_leave_days(numeric, int, date, date) TO service_role;

CREATE OR REPLACE FUNCTION public.update_holiday_allowance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  v_entitlement numeric;
  v_start date;
  v_end date;
  v_year int;
BEGIN
  IF NEW.type = 'holiday' AND NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    -- Contractors have no holiday allowance.
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = NEW.profile_id AND p.employment_type = 'contractor'
    ) THEN
      SELECT pc.annual_leave_entitlement, pc.employment_start_date, pc.employment_end_date
        INTO v_entitlement, v_start, v_end
      FROM public.profile_compensation pc
      WHERE pc.profile_id = NEW.profile_id;

      v_year := EXTRACT(YEAR FROM NEW.start_date)::INT;

      INSERT INTO public.staff_allowances (profile_id, year, total_days, used_days)
      VALUES (NEW.profile_id, v_year,
              public.prorated_leave_days(COALESCE(v_entitlement, 20), v_year, v_start, v_end),
              NEW.total_days)
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

-- 4. Backfill from signed contracts. Only an empty start date is filled, and
--    only from a value that is a real date.
WITH latest AS (
  SELECT DISTINCT ON (c.profile_id)
         c.profile_id, c.variables_data->>'commencement_date' AS cd
  FROM public.contracts c
  WHERE c.status = 'signed'
    AND c.variables_data->>'commencement_date' ~ '^\d{4}-\d{2}-\d{2}$'
  ORDER BY c.profile_id, c.signed_at DESC NULLS LAST
)
INSERT INTO public.profile_compensation (profile_id, employment_start_date)
SELECT l.profile_id, l.cd::date FROM latest l
ON CONFLICT (profile_id) DO UPDATE
  SET employment_start_date = EXCLUDED.employment_start_date,
      updated_at = now()
  WHERE public.profile_compensation.employment_start_date IS NULL;

-- A separate statement: a data-modifying CTE's rows are invisible to the rest
-- of its own statement. The columns are new, so every dated row is a backfill.
UPDATE public.staff_allowances sa
SET total_days = public.prorated_leave_days(COALESCE(pc.annual_leave_entitlement, 20), sa.year, pc.employment_start_date, pc.employment_end_date),
    updated_at = now()
FROM public.profile_compensation pc
WHERE pc.profile_id = sa.profile_id
  AND (pc.employment_start_date IS NOT NULL OR pc.employment_end_date IS NOT NULL)
  AND sa.year <= EXTRACT(YEAR FROM now())::int;
