-- ============================================================
-- 317: Organisation-level branding defaults (org_settings)
--
-- Adds a per-ORGANISATION branding row that locations inherit when
-- they have not set their own. Realises the per-org branding that
-- mig 079 deliberately deferred ("Per-org branding / settings ...
-- addressed separately").
--
-- Resolve order (src/lib/location-branding.js getLocationBranding),
-- PER FIELD:
--   location company_settings  ->  org org_settings  ->  hard 'UN1T'
-- so an org logo can fill in for a location that set only its own
-- name, and a freshly-provisioned location renders the org brand
-- immediately, before anyone configures its per-location row.
--
-- One row per organisation. Mirrors company_settings (mig 013) but
-- keyed on organization_id instead of location_id.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS org_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  logo_url        TEXT,
  favicon_url     TEXT,
  company_name    TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES profiles(id)
);

COMMENT ON TABLE org_settings IS
  'Per-organisation branding defaults inherited by every location in the org that has not set its own (mig 317). Resolved by getLocationBranding per field: location company_settings -> org org_settings -> hard UN1T default. One row per organisation.';

-- ─── RLS ──────────────────────────────────────────────────────────

ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY;

-- Read: members of the org (transitively via their locations) + master.
-- Uses the canonical mig-079 predicate.
DROP POLICY IF EXISTS org_settings_select ON org_settings;
CREATE POLICY org_settings_select ON org_settings
  FOR SELECT
  TO authenticated
  USING (private.auth_is_in_organization(organization_id));

-- Write: master, or an OWNER of any location in this organisation.
-- (No per-org admin role yet — mirrors organizations write = master,
-- but branding is delegated one tier to org owners.)
DROP POLICY IF EXISTS org_settings_write ON org_settings;
CREATE POLICY org_settings_write ON org_settings
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
        FROM public.locations l
        JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = org_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
    )
  )
  WITH CHECK (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
        FROM public.locations l
        JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = org_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
    )
  );

-- ─── updated_at trigger ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.touch_org_settings_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS org_settings_touch_updated_at ON org_settings;
CREATE TRIGGER org_settings_touch_updated_at
  BEFORE UPDATE ON org_settings
  FOR EACH ROW
  EXECUTE FUNCTION private.touch_org_settings_updated_at();

COMMIT;
