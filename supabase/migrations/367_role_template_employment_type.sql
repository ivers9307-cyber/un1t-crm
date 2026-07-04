-- RECEPTION.2 / PERM-AUDIT follow-up — employment-type variants on
-- role permission templates. (Applied to prod via MCP 2026-07-04.)
--
-- A location can now shape a role's defaults per employment type:
-- 'all' rows (the default) apply to every user of the role;
-- 'fte' / 'contractor' / 'casual' rows layer ON TOP of the 'all' row
-- for users whose profiles.employment_type matches. Resolution:
--   code defaults < (role,'all') template < (role,<emp>) template < per-user override
-- Variant rows store the sparse diff vs (code defaults + 'all' row).
--
-- employment_type is NOT NULL DEFAULT 'all' (rather than NULL) so the
-- three-column UNIQUE works with PostgREST upsert onConflict, which
-- cannot target expression indexes.

ALTER TABLE location_role_permissions
  ADD COLUMN employment_type text NOT NULL DEFAULT 'all'
  CHECK (employment_type IN ('all', 'fte', 'contractor', 'casual'));

ALTER TABLE location_role_permissions
  DROP CONSTRAINT location_role_permissions_location_id_role_key;

ALTER TABLE location_role_permissions
  ADD CONSTRAINT location_role_permissions_loc_role_emp_key
  UNIQUE (location_id, role, employment_type);

COMMENT ON COLUMN location_role_permissions.employment_type IS
  'RECEPTION.2 — ''all'' applies to every user of the role; fte/contractor/casual rows layer on top for users whose profiles.employment_type matches. Variant blobs are sparse diffs vs (code defaults + the all row).';
