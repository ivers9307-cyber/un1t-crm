-- OPENWEEK.1 (mig 848): Stillorgan's open week promo (mig 847 made the kind).
--
-- Bound to the private €0 Glofox plan Richard made for it, "2) Black Friday
-- Open Week." (membership 690dbd7bf0dba128580158fa, plan 1762508130342, read
-- off glofox_memberships on 16 Nov 2026). Switched OFF: set live once the
-- /openweek page is ready. TODO(OPENWEEK.2): Richard wants credits equal to
-- the picks instead of a plan, once Glofox's add-credits call is found.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  stillorgan uuid;
BEGIN
  SELECT id INTO stillorgan FROM public.locations WHERE name = 'UN1T Stillorgan';
  IF stillorgan IS NULL THEN
    RAISE EXCEPTION 'mig 848: studio UN1T Stillorgan not found; nothing was applied';
  END IF;

  INSERT INTO public.corp_promos
    (location_id, key, name, platform, credits, expires_in_days, live, tag, lead_source,
     glofox_membership_id, glofox_plan_code, glofox_plan_name,
     kind, window_starts_on, window_ends_on, max_classes, max_per_day)
  VALUES
    (stillorgan, 'stillorgan-open-week', 'Open Week (Stillorgan)', 'glofox', 5, 14, false, 'stillorgan-open-week', 'corp_promo', '690dbd7bf0dba128580158fa', '1762508130342', '2) Black Friday Open Week.', 'open_week', '2026-11-23', '2026-11-30', 5, 1)
  ON CONFLICT (location_id, key) DO NOTHING;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.corp_promos p JOIN public.locations l ON l.id = p.location_id
                 WHERE p.key = 'stillorgan-open-week' AND l.name = 'UN1T Stillorgan' AND p.kind = 'open_week'
                   AND p.platform = 'glofox' AND p.glofox_membership_id = '690dbd7bf0dba128580158fa'
                   AND p.glofox_plan_code = '1762508130342'
                   AND p.window_starts_on = '2026-11-23' AND p.window_ends_on = '2026-11-30'
                   AND p.max_classes = 5 AND p.max_per_day = 1) THEN
    RAISE EXCEPTION 'mig 848: seed row stillorgan-open-week missing or wrong';
  END IF;
END;
$$;

COMMIT;
