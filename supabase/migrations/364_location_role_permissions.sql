-- PERM-AUDIT.2 — operator-editable role permission templates.
--
-- Until now the role→permission defaults lived only in code
-- (shared/permissions.js DEFAULT_*_PERMISSIONS_BY_ROLE), so changing
-- what a role grants meant a deploy. This table adds an operator-
-- editable layer per (location, role) that the shared resolver reads
-- BETWEEN the per-user override and the code defaults:
--
--   tier 1  location feature gate      (locations.features, mig 032)
--   tier 2  per-user override          (profile_locations.permissions, mig 058)
--   tier 2.5 role template             (THIS TABLE)
--   tier 3  code role default          (shared/permissions.js)
--
-- The blob is SPARSE — it stores only the keys the operator changed
-- away from the code default, in the same shape as the per-user blob
-- ({ ...webKeys, mobile: { ...mobileKeys } }). Missing key = code
-- default applies. This means new features added to code defaults
-- flow through automatically, exactly like the per-user layer.
--
-- No 'master' rows: master short-circuits the resolver after the
-- location gate, so a template could never affect a master.
--
-- RLS: enabled with NO policies — all access goes through /api
-- routes on the service role (owner/master gated in app code).
-- The mobile app receives the resolved template via /api/mobile/me,
-- never by querying this table directly.

CREATE TABLE location_role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'head_coach', 'staff')),
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, role)
);

COMMENT ON TABLE location_role_permissions IS
  'PERM-AUDIT.2 — operator-edited role permission templates, resolved between per-user overrides and code role defaults. Sparse: only keys changed away from the code default are stored.';
COMMENT ON COLUMN location_role_permissions.permissions IS
  'Sparse diff vs shared/permissions.js code defaults, same shape as profile_locations.permissions ({ web keys..., mobile: { mobile keys... } }).';

ALTER TABLE location_role_permissions ENABLE ROW LEVEL SECURITY;
