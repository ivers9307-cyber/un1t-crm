-- ============================================================
-- 079: Organizations layer (multi-tenant scaffolding)
--
-- Adds an organizations layer ABOVE locations so the platform can
-- host multiple tenant businesses cleanly. Today both UN1T Group
-- (gym studios) and CCF Autos (cars) are run by the same operator
-- and share one master account, so the org layer is mostly a
-- grouping mechanism. When a third-party business onboards later,
-- their locations slot under their own organization row and the
-- existing per-location RLS continues to work without changes —
-- because every existing data table is scoped by location_id and
-- those locations now belong to a specific org.
--
-- What this migration does NOT do (yet, by design):
--   - Org-level roles. Master remains the platform-wide super-admin;
--     non-master access is still defined per-location via
--     profile_locations.role. An "org admin" tier (someone who
--     manages all locations within their org but isn't a platform
--     master) can be added later as additional helper(s) without
--     reshaping any existing policies.
--   - Cross-org isolation enforcement on data tables. Existing
--     per-location policies already give us tenant isolation
--     transitively (if you're not a member of any of org X's
--     locations, you can't read its data). The org layer adds
--     metadata; it doesn't tighten the data plane.
--   - Per-org branding / settings. Brand chrome is being addressed
--     separately on the AppShell roadmap; that work will read from
--     locations OR organizations depending on UI need.
-- ============================================================

BEGIN;

-- ─── organizations table ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE organizations IS
  'Tenant grouping above locations. Every location belongs to exactly one organization. Master users see all organizations; non-master users see organizations transitively via their location memberships. Adding a new tenant means inserting a row here, then creating that tenant''s locations with the new organization_id.';

COMMENT ON COLUMN organizations.slug IS
  'URL-safe identifier (lowercase, kebab-case). Reserved for future per-org sub-paths or sub-domains. Currently only used by ops to refer to orgs unambiguously.';

-- ─── seed the two existing orgs ──────────────────────────────────
-- UN1T Group covers the gym studios (Hatch Street, Stillorgan, etc).
-- CCF Autos covers the cars business. The backfill below routes
-- existing locations using a heuristic that matches today's reality:
-- only the CCF Autos location has car_deposit_default_amount set.

INSERT INTO organizations (name, slug)
VALUES
  ('UN1T Group', 'un1t-group'),
  ('CCF Autos',  'ccf-autos')
ON CONFLICT (slug) DO NOTHING;

-- ─── locations.organization_id ───────────────────────────────────

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

COMMENT ON COLUMN locations.organization_id IS
  'The tenant organization this location belongs to (mig 079). NOT NULL after the mig 079 backfill — every location must belong to exactly one organization. Adding a new location requires picking an org explicitly via the locations create form.';

-- ─── backfill ────────────────────────────────────────────────────
-- Heuristic: any location that's currently configured for car
-- deposits is the CCF Autos studio (we only have one cars business
-- and it's the only thing that uses the deposit feature). Everything
-- else is UN1T Group. Both orgs are guaranteed to exist after the
-- INSERT above.

UPDATE locations
   SET organization_id = (SELECT id FROM organizations WHERE slug = 'ccf-autos')
 WHERE car_deposit_default_amount IS NOT NULL
   AND organization_id IS NULL;

UPDATE locations
   SET organization_id = (SELECT id FROM organizations WHERE slug = 'un1t-group')
 WHERE organization_id IS NULL;

-- Lock the column NOT NULL now that every existing row is populated.
ALTER TABLE locations
  ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_locations_organization_id
  ON locations (organization_id);

-- ─── RLS on the new organizations table ──────────────────────────

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- Read: master sees all; non-master sees orgs transitively via
-- location memberships (same pattern that protects every other
-- location-scoped table).
DROP POLICY IF EXISTS organizations_select ON organizations;
CREATE POLICY organizations_select ON organizations
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
  );

-- Write: master only. Adding / renaming / deactivating organizations
-- is a platform-level operation, not delegated to per-org admins
-- (there is no per-org admin role yet — see top-of-file note).
DROP POLICY IF EXISTS organizations_master_write ON organizations;
CREATE POLICY organizations_master_write ON organizations
  FOR ALL
  TO authenticated
  USING (private.auth_is_master())
  WITH CHECK (private.auth_is_master());

-- ─── helper for future org-scoped tables ─────────────────────────
-- Mirrors private.auth_is_in_location(loc_id) in style. Returns
-- TRUE when the caller is a master OR is a member of any location
-- belonging to the named organization. RLS-callable from
-- authenticated; service role bypasses.

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
    )
$$;

GRANT EXECUTE ON FUNCTION private.auth_is_in_organization(UUID) TO authenticated;

COMMENT ON FUNCTION private.auth_is_in_organization(UUID) IS
  'Returns TRUE if the caller is a master OR a member of any location belonging to the named organization. Mirrors private.auth_is_in_location(loc_id). Use as the canonical predicate when adding RLS policies on future org-scoped tables.';

-- ─── updated_at trigger on organizations ─────────────────────────

CREATE OR REPLACE FUNCTION private.touch_organizations_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_touch_updated_at ON organizations;
CREATE TRIGGER organizations_touch_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION private.touch_organizations_updated_at();

COMMIT;
