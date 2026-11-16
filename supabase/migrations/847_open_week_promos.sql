-- OPENWEEK.1 (mig 847): open week promos.
--
-- An open week is a corp_promos row of kind 'open_week': a window of
-- studio-local dates the visitor may book classes in, and limits on how many
-- (max_classes in all, max_per_day on any one day). The visitor picks their
-- classes on /openweek; the claim records each pick in corp_promo_claim_classes
-- and the fulfilment books every one (src/lib/open-week.js holds the rules).
-- credits / expires_in_days stay NOT NULL on every row: for an open week they
-- are only the staff-card fallback, the grant is the number of picks.
--
-- The Stillorgan row is NOT seeded: its Glofox plan does not exist yet, and a
-- glofox row needs the binding (corp_promos_glofox_plan_check). It lands in a
-- follow-up migration with the plan ids, the NEWSTART.2 way.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) corp_promos: kind, window, limits
-- ---------------------------------------------------------------------------
ALTER TABLE public.corp_promos
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'promo',
  ADD COLUMN IF NOT EXISTS window_starts_on date,
  ADD COLUMN IF NOT EXISTS window_ends_on date,
  ADD COLUMN IF NOT EXISTS max_classes integer,
  ADD COLUMN IF NOT EXISTS max_per_day integer;

ALTER TABLE public.corp_promos DROP CONSTRAINT IF EXISTS corp_promos_kind_check;
ALTER TABLE public.corp_promos
  ADD CONSTRAINT corp_promos_kind_check CHECK (kind IN ('promo', 'open_week'));

ALTER TABLE public.corp_promos DROP CONSTRAINT IF EXISTS corp_promos_max_classes_check;
ALTER TABLE public.corp_promos
  ADD CONSTRAINT corp_promos_max_classes_check CHECK (max_classes IS NULL OR max_classes BETWEEN 1 AND 20);

ALTER TABLE public.corp_promos DROP CONSTRAINT IF EXISTS corp_promos_max_per_day_check;
ALTER TABLE public.corp_promos
  ADD CONSTRAINT corp_promos_max_per_day_check CHECK (max_per_day IS NULL OR max_per_day BETWEEN 1 AND 5);

ALTER TABLE public.corp_promos DROP CONSTRAINT IF EXISTS corp_promos_open_week_check;
ALTER TABLE public.corp_promos
  ADD CONSTRAINT corp_promos_open_week_check
  CHECK (kind <> 'open_week' OR (window_starts_on IS NOT NULL AND window_ends_on IS NOT NULL AND window_ends_on >= window_starts_on AND max_classes IS NOT NULL AND max_per_day IS NOT NULL));

COMMENT ON COLUMN public.corp_promos.kind IS
  'OPENWEEK.1 (mig 847): promo (a fixed credit grant, /corp, /newstart) | open_week (the visitor picks classes inside window_starts_on..window_ends_on, up to max_classes and max_per_day a day, and each is booked).';
COMMENT ON COLUMN public.corp_promos.window_starts_on IS
  'OPENWEEK.1 (mig 847): first studio-local date an open week class may be booked. Required for kind open_week.';
COMMENT ON COLUMN public.corp_promos.window_ends_on IS
  'OPENWEEK.1 (mig 847): last studio-local date (inclusive) an open week class may be booked; signups close after it. Required for kind open_week.';
COMMENT ON COLUMN public.corp_promos.max_classes IS
  'OPENWEEK.1 (mig 847): most classes one person may pick for the open week. Required for kind open_week.';
COMMENT ON COLUMN public.corp_promos.max_per_day IS
  'OPENWEEK.1 (mig 847): most classes one person may pick on one studio-local day. Required for kind open_week.';

-- ---------------------------------------------------------------------------
-- (2) the classes an open week claim picked
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.corp_promo_claim_classes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        uuid        NOT NULL REFERENCES public.corp_promo_claims(id) ON DELETE CASCADE,
  location_id     uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  class_event_id  text        NOT NULL,
  class_name      text,
  class_starts_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corp_promo_claim_classes_claim_class_unique UNIQUE (claim_id, class_event_id)
);

CREATE INDEX IF NOT EXISTS corp_promo_claim_classes_location_idx
  ON public.corp_promo_claim_classes (location_id, class_starts_at);

ALTER TABLE public.corp_promo_claim_classes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.corp_promo_claim_classes FROM anon, authenticated;
REVOKE ALL ON public.corp_promo_claim_classes FROM PUBLIC;

COMMENT ON TABLE public.corp_promo_claim_classes IS
  'OPENWEEK.1 (mig 847): one row per class an open week claim picked (the studio''s event id, server-validated against the window and limits). Each is queued as a funded class booking after the grant. Service role only.';

-- ---------------------------------------------------------------------------
-- (3) seed: Hatch Street's open week, switched off until launch
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  hatch uuid;
BEGIN
  SELECT id INTO hatch FROM public.locations WHERE name = 'UN1T Hatch Street';
  IF hatch IS NULL THEN
    RAISE EXCEPTION 'mig 847: studio UN1T Hatch Street not found; nothing was applied';
  END IF;

  INSERT INTO public.corp_promos
    (location_id, key, name, platform, credits, expires_in_days, live, tag, lead_source,
     kind, window_starts_on, window_ends_on, max_classes, max_per_day)
  VALUES
    (hatch, 'hatch-open-week', 'Open Week (Hatch Street)', 'un1t_online', 5, 14, false, 'hatch-open-week', 'corp_promo', 'open_week', '2026-11-23', '2026-11-30', 5, 1)
  ON CONFLICT (location_id, key) DO NOTHING;
END;
$$;

-- ---------------------------------------------------------------------------
-- Self-check: the post-state in the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = 'corp_promo_claim_classes' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'mig 847: corp_promo_claim_classes missing or RLS off';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'corp_promo_claim_classes') THEN
    RAISE EXCEPTION 'mig 847: corp_promo_claim_classes must carry no policy';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name IN ('corp_promo_claim_classes', 'corp_promos')
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 847: a client role holds a privilege on corp_promo_claim_classes or corp_promos';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.corp_promos p JOIN public.locations l ON l.id = p.location_id
                 WHERE p.key = 'hatch-open-week' AND l.name = 'UN1T Hatch Street' AND p.kind = 'open_week'
                   AND p.window_starts_on = '2026-11-23' AND p.window_ends_on = '2026-11-30'
                   AND p.max_classes = 5 AND p.max_per_day = 1) THEN
    RAISE EXCEPTION 'mig 847: seed row hatch-open-week missing or wrong';
  END IF;
END;
$$;

COMMIT;
