-- ============================================================
-- 417: profile_organizations — the org-admin role tier (SAAS-4)
--
-- Applied to prod via Supabase MCP (apply_migration); this file
-- mirrors it for history and fresh-env replay, so it is written
-- idempotently.
--
-- Mig 079 added the organizations layer above locations and left a
-- deliberate gap (see its top-of-file note): the only above-location
-- tier is master (profiles.role), which sees EVERY tenant. A SaaS
-- customer's org owner needs to manage all locations in THEIR org
-- only. This migration fills that gap:
--
--   profile_organizations — org-level role grants. One row =
--     "this profile is org_admin of this organization". App-side,
--     getCurrentUser() expands an org admin's access to every
--     active location of the org, acting as 'owner' anywhere they
--     have no explicit profile_locations row (explicit rows keep
--     their role). Master remains platform-wide and supersedes —
--     a master never needs a row here.
--
--   private.auth_is_in_organization(org_id) — extended to also
--     return TRUE for a profile_organizations membership, so every
--     existing (and future) org-scoped RLS policy built on the
--     canonical predicate picks up the new tier for free.
--
--   organizations_select — extended so an org admin can read their
--     org row even when the org has no locations yet (the previous
--     policy only reached orgs transitively via location
--     memberships).
--
-- Rollout safety: zero rows in profile_organizations = zero
-- behaviour change anywhere (every new predicate is an OR-branch
-- that matches nothing).
-- ============================================================

BEGIN;

-- ─── profile_organizations table ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profile_organizations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Single value today; CHECK keeps the door open for future org
  -- tiers (e.g. 'org_viewer') without a reshape.
  role            TEXT NOT NULL DEFAULT 'org_admin' CHECK (role IN ('org_admin')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, organization_id)
);

COMMENT ON TABLE public.profile_organizations IS
  'Org-level role grants (mig 417). org_admin = manages every location in the org: getCurrentUser() expands their access to all active org locations, acting as owner wherever they have no explicit profile_locations row. Master is platform-wide on profiles.role and never needs a row here. Grant/revoke is master-only.';

COMMENT ON COLUMN public.profile_organizations.role IS
  'Org-level role. Only ''org_admin'' today; CHECK-constrained so future tiers are an explicit migration.';

-- FK indexes. The UNIQUE(profile_id, organization_id) constraint
-- already provides the covering index for the profile_id FK (leading
-- column), so a separate ix on profile_id would be a duplicate the
-- perf advisor flags; organization_id needs its own.
CREATE INDEX IF NOT EXISTS ix_profile_organizations_organization_id
  ON public.profile_organizations (organization_id);

-- ─── RLS ─────────────────────────────────────────────────────────
-- One permissive SELECT policy (own rows OR master); explicit
-- master-only INSERT/UPDATE/DELETE — never a FOR ALL alongside the
-- SELECT (multiple_permissive_policies, see mig 320).

ALTER TABLE public.profile_organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profile_organizations_select ON public.profile_organizations;
CREATE POLICY profile_organizations_select ON public.profile_organizations
  FOR SELECT
  TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    OR private.auth_is_master()
  );

DROP POLICY IF EXISTS profile_organizations_ins ON public.profile_organizations;
CREATE POLICY profile_organizations_ins ON public.profile_organizations
  FOR INSERT
  TO authenticated
  WITH CHECK (private.auth_is_master());

DROP POLICY IF EXISTS profile_organizations_upd ON public.profile_organizations;
CREATE POLICY profile_organizations_upd ON public.profile_organizations
  FOR UPDATE
  TO authenticated
  USING (private.auth_is_master())
  WITH CHECK (private.auth_is_master());

DROP POLICY IF EXISTS profile_organizations_del ON public.profile_organizations;
CREATE POLICY profile_organizations_del ON public.profile_organizations
  FOR DELETE
  TO authenticated
  USING (private.auth_is_master());

-- ─── auth_is_in_organization — add the org-admin branch ──────────
-- Preserves mig 079's semantics exactly (master OR member of any org
-- location) and appends the profile_organizations membership check.
-- Every org-scoped policy built on this predicate now honours org
-- admins without being touched.

CREATE OR REPLACE FUNCTION private.auth_is_in_organization(org_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT org_id IS NOT NULL
    AND (
      private.auth_is_master()
      OR EXISTS (
        SELECT 1
          FROM public.locations l
          JOIN public.profile_locations pl ON pl.location_id = l.id
         WHERE l.organization_id = org_id
           AND pl.profile_id = (SELECT auth.uid())
      )
      OR EXISTS (
        SELECT 1
          FROM public.profile_organizations po
         WHERE po.organization_id = org_id
           AND po.profile_id = (SELECT auth.uid())
      )
    )
$$;

GRANT EXECUTE ON FUNCTION private.auth_is_in_organization(UUID) TO authenticated;

COMMENT ON FUNCTION private.auth_is_in_organization(UUID) IS
  'Returns TRUE if the caller is a master OR a member of any location belonging to the named organization OR holds a profile_organizations grant on it (mig 417 org-admin tier). Mirrors private.auth_is_in_location(loc_id). Use as the canonical predicate when adding RLS policies on future org-scoped tables.';

-- ─── organizations_select — org admins read their org row ────────
-- Still ONE permissive SELECT policy; the org-admin membership is a
-- third OR-branch. Without this, an org admin of an org with no
-- locations yet couldn't read the org row through RLS-bound clients.

DROP POLICY IF EXISTS organizations_select ON public.organizations;
CREATE POLICY organizations_select ON public.organizations
  FOR SELECT
  TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
        FROM public.locations l
        JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = organizations.id
         AND pl.profile_id = (SELECT auth.uid())
    )
    OR EXISTS (
      SELECT 1
        FROM public.profile_organizations po
       WHERE po.organization_id = organizations.id
         AND po.profile_id = (SELECT auth.uid())
    )
  );

COMMIT;
