-- OPENWEEK.6 (mig 857): open week is seven days, Monday 23 to Sunday 29
-- November 2026 (Richard, 19 Nov). Mig 847/848 ended the window on Mon 30.
-- The page lists, and the claim route accepts, only classes inside the
-- window, so nothing on Monday 30 can be picked after this. Picks already
-- made for the 30th are left as they are (their bookings exist).

BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE public.corp_promos
   SET window_ends_on = '2026-11-29'
 WHERE key IN ('hatch-open-week', 'stillorgan-open-week')
   AND kind = 'open_week'
   AND window_ends_on = '2026-11-30';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.corp_promos
              WHERE key IN ('hatch-open-week', 'stillorgan-open-week')
                AND window_ends_on <> '2026-11-29') THEN
    RAISE EXCEPTION 'mig 857: an open week row does not end on 2026-11-29';
  END IF;
END;
$$;

COMMIT;
