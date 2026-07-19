-- ============================================================
-- 414: chooser_settings — de-singleton to per-ORGANIZATION (SAAS-6)
--
-- Mig 228 created chooser_settings as a hard singleton
-- (id text PRIMARY KEY CHECK (id = 'default')) backing the public
-- front-page split chooser at un1tdublin.com (/welcome, edited at
-- /settings/landing-page via /api/chooser-settings). In a multi-
-- tenant SaaS every tenant brand gets its OWN front page, and the
-- tenant dimension is the ORGANIZATION (tiles are the org's
-- locations; SAAS-8 tenant_domains will map hostname → org).
--
--   1. organization_id column (nullable during transition, CASCADE
--      with the org).
--   2. Backfill the legacy 'default' row to the UN1T Group org —
--      resolved by SLUG ('un1t-group', verified present in prod),
--      never a hardcoded UUID.
--   3. UNIQUE index on organization_id — ONE chooser per org.
--   4. REPLACE the singleton CHECK. Keeping it intact was the
--      preferred plan, but id is the PRIMARY KEY and the CHECK pins
--      id = 'default' — together they admit AT MOST ONE ROW, so
--      multi-org rows are structurally impossible with it in place.
--      The replacement keeps the id space just as constrained: the
--      legacy row keeps id = 'default'; every new row must derive
--      its id from its org ('org:<uuid>'). One-row-per-org is
--      enforced by the UNIQUE index, not the CHECK.
--   5. RLS: mig 228/242/320 policies (public read; master-or-ANY-
--      owner writes — a cross-org hole: one tenant's owner could
--      edit another tenant's front page) are replaced with org-
--      scoped ones. Reads = org membership (the public /welcome
--      render goes through the service role, so anon SELECT is not
--      needed); writes = master, org_admin of the org, or an owner
--      WITHIN the org. Defence in depth — /api/chooser-settings
--      (service role) is the primary gate and mirrors these tiers.
-- ============================================================

BEGIN;

-- ─── 1. organization_id ──────────────────────────────────────────

ALTER TABLE public.chooser_settings
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.chooser_settings.organization_id IS
  'Owning organization (SAAS-6, mig 414). One chooser row per org (UNIQUE index); the legacy singleton row (id=''default'') is backfilled to the UN1T Group org. Nullable only as a transition shape — every row the app writes carries an org.';

COMMENT ON TABLE public.chooser_settings IS
  'Per-ORGANIZATION front-page chooser config (de-singletoned in mig 414; was a hard singleton from mig 228): optional headline/intro across the split + the left->right tile order (array of landing_page_settings.public_path values, scoped to the org''s locations). Read by the public /welcome render (service role) and edited via /api/chooser-settings.';

-- ─── 2. Backfill the legacy singleton to UN1T Group ──────────────
-- Slug subquery, not a hardcoded UUID. If the org were ever missing
-- the row simply stays NULL-org (readable by master; the /welcome
-- reader falls back to the id='default' row) rather than failing.

UPDATE public.chooser_settings
   SET organization_id = (SELECT id FROM public.organizations WHERE slug = 'un1t-group')
 WHERE id = 'default'
   AND organization_id IS NULL;

-- ─── 3. One chooser per org ──────────────────────────────────────
-- Plain (non-partial) unique index: NULL org rows don't collide,
-- which is exactly the transition semantics we want.

CREATE UNIQUE INDEX IF NOT EXISTS ux_chooser_settings_organization_id
  ON public.chooser_settings (organization_id);

-- ─── 4. Replace the singleton CHECK ──────────────────────────────
-- See header for why "keep it intact" was impossible (PK + CHECK
-- id='default' = max one row). Dropped by catalog lookup rather than
-- by its auto-generated name so a differently-named inline CHECK
-- can't survive and silently keep the table single-row.

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.chooser_settings'::regclass
              AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE public.chooser_settings DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.chooser_settings
  ADD CONSTRAINT chooser_settings_id_check
  CHECK (
    id = 'default'
    OR (organization_id IS NOT NULL AND id = 'org:' || organization_id::text)
  );

-- ─── 5. RLS — org-scoped read + org-admin/owner-in-org writes ────
-- One permissive SELECT; explicit per-command writes (never FOR ALL
-- alongside a SELECT — multiple_permissive_policies, mig 320);
-- TO authenticated; (SELECT auth.uid()) wrapping via the canonical
-- predicates / inline EXISTS.

DROP POLICY IF EXISTS chooser_settings_public_read ON public.chooser_settings; -- mig 228
DROP POLICY IF EXISTS chooser_settings_write       ON public.chooser_settings; -- mig 228/242 shape
DROP POLICY IF EXISTS chooser_settings_ins         ON public.chooser_settings; -- mig 320
DROP POLICY IF EXISTS chooser_settings_upd         ON public.chooser_settings; -- mig 320
DROP POLICY IF EXISTS chooser_settings_del         ON public.chooser_settings; -- mig 320

-- Read: members of the org (transitively via locations, or an org
-- grant) + master. auth_is_in_organization returns FALSE for a NULL
-- org, so the master branch also covers any transitional NULL-org row.
CREATE POLICY chooser_settings_select ON public.chooser_settings
  FOR SELECT
  TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_in_organization(organization_id)
  );

-- Write tier: master, org_admin of THIS org (mig 411), or an OWNER of
-- any location in THIS org — mirroring the app-layer gate in
-- /api/chooser-settings (assertOrganizationAdmin semantics with the
-- getOwnerOrganizationIds owner opt-in, same delegation as mig 317's
-- org_settings). ANY-owner is gone: the org join bounds every branch.
CREATE POLICY chooser_settings_ins ON public.chooser_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
        FROM public.profile_organizations po
       WHERE po.organization_id = chooser_settings.organization_id
         AND po.profile_id = (SELECT auth.uid())
         AND po.role = 'org_admin'
    )
    OR EXISTS (
      SELECT 1
        FROM public.locations l
        JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = chooser_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
    )
  );

CREATE POLICY chooser_settings_upd ON public.chooser_settings
  FOR UPDATE
  TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
        FROM public.profile_organizations po
       WHERE po.organization_id = chooser_settings.organization_id
         AND po.profile_id = (SELECT auth.uid())
         AND po.role = 'org_admin'
    )
    OR EXISTS (
      SELECT 1
        FROM public.locations l
        JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = chooser_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
    )
  )
  WITH CHECK (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
        FROM public.profile_organizations po
       WHERE po.organization_id = chooser_settings.organization_id
         AND po.profile_id = (SELECT auth.uid())
         AND po.role = 'org_admin'
    )
    OR EXISTS (
      SELECT 1
        FROM public.locations l
        JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = chooser_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
    )
  );

CREATE POLICY chooser_settings_del ON public.chooser_settings
  FOR DELETE
  TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
        FROM public.profile_organizations po
       WHERE po.organization_id = chooser_settings.organization_id
         AND po.profile_id = (SELECT auth.uid())
         AND po.role = 'org_admin'
    )
    OR EXISTS (
      SELECT 1
        FROM public.locations l
        JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = chooser_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
    )
  );

COMMIT;
