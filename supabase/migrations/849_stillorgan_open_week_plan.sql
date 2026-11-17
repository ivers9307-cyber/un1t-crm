-- OPENWEEK.1 (mig 849): bind Stillorgan's open week to the public Glofox
-- membership "2) Black Friday Open Week." (690dbd7619bfd5948a0ac79d).
--
-- Mig 848 bound an older membership of the same name and plan code
-- (690dbd7bf0dba128580158fa), last seen in Glofox on 8 Nov 2026. Glofox no
-- longer sells it: the first open week claim at Stillorgan (16 Nov 19:15 UTC)
-- was refused ERROR_CONNECTING_WITH_MEMBERSHIP_SERVICE. Richard confirmed on
-- 16 Nov that the public "2) Black Friday Open Week." is the plan to add.
-- The plan code (1762508130342) is the same on both.

BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE public.corp_promos
   SET glofox_membership_id = '690dbd7619bfd5948a0ac79d'
 WHERE key = 'stillorgan-open-week'
   AND glofox_membership_id = '690dbd7bf0dba128580158fa';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.corp_promos p JOIN public.locations l ON l.id = p.location_id
                 WHERE p.key = 'stillorgan-open-week' AND l.name = 'UN1T Stillorgan'
                   AND p.glofox_membership_id = '690dbd7619bfd5948a0ac79d'
                   AND p.glofox_plan_code = '1762508130342') THEN
    RAISE EXCEPTION 'mig 849: stillorgan-open-week is not bound to membership 690dbd7619bfd5948a0ac79d';
  END IF;
END;
$$;

COMMIT;
