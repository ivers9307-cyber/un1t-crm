-- AC-ROLE.1 (mig 379) — role-level AC device defaults.
--
-- 1. Add ac_device_ids to the per-(location, role, employment_type)
--    template table. NULL = inherit code default, [] = none,
--    [ids] = those (same semantics as profile_locations.ac_device_ids).
-- 2. Flip the blanket mig-210 empty-array backfill on profile_locations
--    to NULL so those staff INHERIT the role default instead of being
--    pinned to "none". Deliberate non-empty per-person lists and the
--    manager/owner NULLs are untouched. Day-one access is unchanged
--    (staff -> none via code default; manager/owner -> all).

alter table location_role_permissions
  add column if not exists ac_device_ids uuid[];

update profile_locations
   set ac_device_ids = null
 where ac_device_ids = '{}';
