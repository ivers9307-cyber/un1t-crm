-- 233: GLOFOX-CATALOG — the studio's membership catalog (plan-level).
--
-- Glofox /2.0/memberships returns the studio's plans, each carrying a
-- `description` (the customer-facing pricing + commitment terms, e.g.
-- "€99 first month, €209 thereafter, 30-day notice, 3 month
-- commitment"). We were fetching this object during sync but only
-- reading `.name`, discarding the description and the structured plans.
--
-- A plan's detail is the SAME for every member on it, so this is
-- plan-level data, not per-member. One small table (~8 rows/location),
-- refreshed by the glofox-sync cron. The contact profile + the customer
-- agent resolve a member's description by matching their plan name
-- against this catalog (current plans only — archived/seasonal plans
-- like old Black Friday offers are no longer returned by Glofox).

CREATE TABLE IF NOT EXISTS public.glofox_memberships (
  glofox_membership_id text PRIMARY KEY,           -- Glofox membership _id
  location_id          uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name                 text,                        -- full catalog name (keeps "N) " prefix)
  name_clean           text,                        -- "N) " prefix stripped
  description          text,                        -- customer-facing terms/pricing text
  membership_type      text,                        -- Glofox 'type' (membership)
  active               boolean,
  plan_names           text[],                      -- plans[].name, for name-match join
  price_cents          integer,                     -- first plan price * 100 (best-effort)
  plans                jsonb,                        -- raw plans[] (code/price/duration/etc.)
  synced_at            timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_glofox_memberships_location
  ON public.glofox_memberships (location_id, active);
CREATE INDEX IF NOT EXISTS idx_glofox_memberships_name_clean
  ON public.glofox_memberships (location_id, name_clean);

ALTER TABLE public.glofox_memberships ENABLE ROW LEVEL SECURITY;

-- Read: staff assigned to the location (+ master). It's non-sensitive
-- catalog data, but scope it consistently with the other glofox tables.
DROP POLICY IF EXISTS glofox_memberships_select ON public.glofox_memberships;
CREATE POLICY glofox_memberships_select ON public.glofox_memberships
  FOR SELECT
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = glofox_memberships.location_id
                 AND pl.profile_id = auth.uid())
  );

-- Write: service-role only (the sync cron uses the service client).
DROP POLICY IF EXISTS glofox_memberships_deny_writes ON public.glofox_memberships;
CREATE POLICY glofox_memberships_deny_writes ON public.glofox_memberships
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);
