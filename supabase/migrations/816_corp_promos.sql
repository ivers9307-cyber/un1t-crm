-- 816 — WAYSIN.1: corporate promos move from the frozen CORP_PROMOS registry
-- (src/lib/corp-promos.js) to a table, one row per studio and key.
--
-- WHY. The pipeline builder's "ways in" become editable: an owner adds or
-- switches off a /corp promo at their studio instead of a code change. The
-- registry stays in code only as the seed below; the table is the truth once
-- the readers move (WAYSIN.2/.3).
--
-- WHAT.
--   (1) public.corp_promos: the promo definition (studio, key, platform,
--       credits, expiry, live switch, tag, lead source) plus the Glofox plan
--       binding that lived in src/lib/corp-promo-glofox-plans.js. A key is
--       unique per studio, never estate-wide (two studios may share one). A
--       Glofox promo must name its plan (membership id, plan code, plan name),
--       so a row that could only ever grant nothing cannot exist.
--   (2) corp_promo_claims.platform (nullable): the promo's platform, stamped
--       at claim time from WAYSIN.3 on; backfilled here from the registry by
--       promo_key ('hatch-3-free' -> un1t_online, 'stillorgan-newstart' ->
--       glofox).
--   (3) corp_promo_claims_one_live_per_contact is rebuilt on platform instead
--       of the 'stillorgan-newstart' literal (mig 811), so a new Glofox promo
--       is covered without a migration. Columns (promo_key, contact_id) and
--       the status list ('processing', 'granted', 'help_requested', 'handled')
--       are mig 811's, unchanged: one live claim per person PER PROMO, which
--       is what the claim route's 23505 branch and the Glofox eligibility read
--       (promo_key + location) assume. un1t.online claims stay outside it, as
--       in 811.
--   (4) The seed: today's two promos, values copied from CORP_PROMOS and
--       CORP_PROMO_GLOFOX_PLANS, studios resolved by locations.name. A missing
--       studio raises (nothing is applied).
--
-- AUDIT. corp_promos carries the audit_mutation trigger
-- (private.log_mutation('id', 'created_by'), mig 733's arguments): every
-- create, edit and switch-off of a promo leaves an audit_events row. The actor
-- column is read only for a service-role API INSERT/UPDATE with no auth.uid();
-- with no updated_by column an edit is credited to the promo's creator. No
-- column matches private.audit_is_secret_key (plan ids are not credentials);
-- tests/helpers/audit-secret-keys.js lists the table in AUDITED_TABLES.
--
-- grant: public.corp_promos service_role only (RLS on, no policy, REVOKE ALL from anon, authenticated)
-- grant: none on corp_promo_claims (mig 787: service role only, unchanged)
-- column-grant: n/a, no column-granted table touched.
--
-- LOCKS. One transaction, 5s lock_timeout. corp_promo_claims is small (a
-- handful of rows); the index rebuild and the backfill are instant.
--
-- IDEMPOTENT. IF NOT EXISTS on the table and column, DROP-then-CREATE on the
-- index and trigger, ON CONFLICT DO NOTHING on the seed. The DO block checks
-- the POST-STATE in the catalog.
--
-- ORDER. Apply BEFORE the code that reads corp_promos deploys. Until then
-- nothing reads the table and the claim route keeps reading the registry; the
-- rebuilt index admits exactly the rows 811's did (every existing Glofox claim
-- is backfilled 'glofox', and the route does not yet stamp platform, so a NEW
-- Glofox claim before WAYSIN.3 deploys sits outside the index: deploy WAYSIN.3
-- promptly after this).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) corp_promos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.corp_promos (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  key                  text        NOT NULL
                         CONSTRAINT corp_promos_key_check CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name                 text        NOT NULL,
  platform             text        NOT NULL
                         CONSTRAINT corp_promos_platform_check CHECK (platform IN ('un1t_online', 'glofox')),
  credits              integer     NOT NULL
                         CONSTRAINT corp_promos_credits_check CHECK (credits BETWEEN 1 AND 50),
  expires_in_days      integer     NOT NULL
                         CONSTRAINT corp_promos_expires_in_days_check CHECK (expires_in_days BETWEEN 1 AND 365),
  live                 boolean     NOT NULL DEFAULT false,
  tag                  text        NOT NULL,
  lead_source          text        NOT NULL DEFAULT 'corp_promo',
  glofox_membership_id text,
  glofox_plan_code     text,
  glofox_plan_name     text,
  created_by           uuid        REFERENCES public.profiles(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corp_promos_location_key_unique UNIQUE (location_id, key),
  CONSTRAINT corp_promos_glofox_plan_check CHECK (
    platform <> 'glofox'
    OR (glofox_membership_id IS NOT NULL AND glofox_plan_code IS NOT NULL AND glofox_plan_name IS NOT NULL)
  )
);

CREATE OR REPLACE TRIGGER trg_corp_promos_updated_at BEFORE UPDATE ON public.corp_promos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.corp_promos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.corp_promos FROM anon, authenticated;
REVOKE ALL ON public.corp_promos FROM PUBLIC;

-- private.log_mutation (mig 733): optional key column and actor column.
DROP TRIGGER IF EXISTS audit_mutation ON public.corp_promos;
CREATE TRIGGER audit_mutation AFTER INSERT OR UPDATE OR DELETE ON public.corp_promos
  FOR EACH ROW EXECUTE FUNCTION private.log_mutation('id', 'created_by');

COMMENT ON TABLE public.corp_promos IS
  'WAYSIN.1 (mig 816): one row per /corp promo per studio (key unique per location). platform un1t_online grants credits through grantPromoCredits; platform glofox buys the glofox_* plan (all three required). Seeded from the CORP_PROMOS registry. Service role only.';

-- ---------------------------------------------------------------------------
-- (2) corp_promo_claims.platform, backfilled from the registry
-- ---------------------------------------------------------------------------
ALTER TABLE public.corp_promo_claims
  ADD COLUMN IF NOT EXISTS platform text;

ALTER TABLE public.corp_promo_claims DROP CONSTRAINT IF EXISTS corp_promo_claims_platform_check;
ALTER TABLE public.corp_promo_claims
  ADD CONSTRAINT corp_promo_claims_platform_check
  CHECK (platform IS NULL OR platform IN ('un1t_online', 'glofox'));

UPDATE public.corp_promo_claims
   SET platform = CASE promo_key
                    WHEN 'hatch-3-free' THEN 'un1t_online'
                    WHEN 'stillorgan-newstart' THEN 'glofox'
                  END
 WHERE platform IS NULL
   AND promo_key IN ('hatch-3-free', 'stillorgan-newstart');

COMMENT ON COLUMN public.corp_promo_claims.platform IS
  'WAYSIN.1 (mig 816): the promo''s platform (un1t_online | glofox) at claim time. Keys corp_promo_claims_one_live_per_contact. Null only on a row written before WAYSIN.3 by a promo key the backfill did not know.';

-- ---------------------------------------------------------------------------
-- (3) one live claim per person per Glofox promo, keyed on platform
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.corp_promo_claims_one_live_per_contact;

CREATE UNIQUE INDEX corp_promo_claims_one_live_per_contact
  ON public.corp_promo_claims (promo_key, contact_id)
  WHERE status IN ('processing', 'granted', 'help_requested', 'handled')
    AND platform = 'glofox';

-- ---------------------------------------------------------------------------
-- (4) seed: today's two promos
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  hatch uuid;
  stillorgan uuid;
BEGIN
  SELECT id INTO hatch FROM public.locations WHERE name = 'UN1T Hatch Street';
  IF hatch IS NULL THEN
    RAISE EXCEPTION 'mig 816: studio UN1T Hatch Street not found; nothing was applied';
  END IF;
  SELECT id INTO stillorgan FROM public.locations WHERE name = 'UN1T Stillorgan';
  IF stillorgan IS NULL THEN
    RAISE EXCEPTION 'mig 816: studio UN1T Stillorgan not found; nothing was applied';
  END IF;

  INSERT INTO public.corp_promos
    (location_id, key, name, platform, credits, expires_in_days, live, tag, lead_source,
     glofox_membership_id, glofox_plan_code, glofox_plan_name)
  VALUES
    (hatch, 'hatch-3-free', 'Corporate trial (Hatch Street)', 'un1t_online', 3, 7, true,
     'hatch-corp-promo', 'corp_promo', NULL, NULL, NULL),
    (stillorgan, 'stillorgan-newstart', 'New Start (Stillorgan)', 'glofox', 3, 7, true,
     'stillorgan-newstart', 'corp_promo', '6aec95d590a936f18c065d9f', '1793889679121', 'New Start Free Trial')
  ON CONFLICT (location_id, key) DO NOTHING;
END;
$$;

-- ---------------------------------------------------------------------------
-- Self-check: the post-state in the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  d text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = 'corp_promos' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'mig 816: corp_promos missing or RLS off';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'corp_promos') THEN
    RAISE EXCEPTION 'mig 816: corp_promos must carry no policy';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name = 'corp_promos'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 816: a client role holds a privilege on corp_promos';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
             WHERE table_schema = 'public' AND table_name = 'corp_promos'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 816: a client role holds a column privilege on corp_promos';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.corp_promos'::regclass AND tgname = 'audit_mutation' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'mig 816: audit_mutation trigger missing on corp_promos';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.corp_promos p JOIN public.locations l ON l.id = p.location_id
                 WHERE p.key = 'hatch-3-free' AND l.name = 'UN1T Hatch Street'
                   AND p.platform = 'un1t_online' AND p.credits = 3 AND p.expires_in_days = 7 AND p.live) THEN
    RAISE EXCEPTION 'mig 816: seed row hatch-3-free missing or wrong';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.corp_promos p JOIN public.locations l ON l.id = p.location_id
                 WHERE p.key = 'stillorgan-newstart' AND l.name = 'UN1T Stillorgan'
                   AND p.platform = 'glofox' AND p.credits = 3 AND p.expires_in_days = 7 AND p.live
                   AND p.glofox_membership_id = '6aec95d590a936f18c065d9f'
                   AND p.glofox_plan_code = '1793889679121'
                   AND p.glofox_plan_name = 'New Start Free Trial') THEN
    RAISE EXCEPTION 'mig 816: seed row stillorgan-newstart missing or wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM public.corp_promo_claims
             WHERE platform IS NULL AND promo_key IN ('hatch-3-free', 'stillorgan-newstart')) THEN
    RAISE EXCEPTION 'mig 816: corp_promo_claims.platform not backfilled';
  END IF;
  SELECT indexdef INTO d FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'corp_promo_claims' AND indexname = 'corp_promo_claims_one_live_per_contact';
  IF d IS NULL OR d NOT LIKE 'CREATE UNIQUE INDEX%' OR position('platform' IN d) = 0
     OR position('stillorgan-newstart' IN d) > 0 OR position('handled' IN d) = 0 THEN
    RAISE EXCEPTION 'mig 816: corp_promo_claims_one_live_per_contact missing or wrong: %', d;
  END IF;
END;
$$;

COMMIT;
