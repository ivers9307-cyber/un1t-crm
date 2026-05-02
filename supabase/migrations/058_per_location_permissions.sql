-- 058 — per-location user permission overrides
--
-- Migration 051 made roles per-location. permissions stayed
-- profile-wide, which leaks privileges across locations: an owner
-- at studio A who is staff at studio B was getting the owner-level
-- toggles (dashboards business/studio, settings, whatsapp, etc.) at
-- studio B too because hasPermission()'s tier-2 read came from
-- profiles.permissions regardless of active location.
--
-- This migration moves the user-override layer into
-- profile_locations.permissions (JSONB, default '{}').
--
-- After this lands:
--   - hasPermission()'s tier-2 reads from the active assignment's
--     permissions rather than profiles.permissions.
--   - Empty {} means "use the role default for my role at this
--     location" — exactly what we want as the new neutral state.
--
-- Smart backfill: for each existing profile that has a non-empty
-- permissions blob, copy it to the ONE assignment whose role matches
-- profiles.role. Other assignments stay empty so role defaults
-- apply. This preserves current behaviour for users whose role is
-- consistent across locations (the common case) while automatically
-- correcting the leak for users with mixed roles (e.g. an owner at
-- one studio + staff at another — they keep owner privs at the
-- owner location and revert to staff defaults elsewhere).
--
-- Master users are unaffected: hasPermission() short-circuits to
-- true after the location feature gate for masters, so per-location
-- overrides are never consulted for them.
--
-- profiles.permissions is NOT dropped in this migration. Reads are
-- removed from hasPermission() / canMobile() / canDashboard() in the
-- accompanying code change, but the column stays so we can roll
-- back without data loss. A follow-up migration can clean it up
-- once the per-location model is settled.

alter table profile_locations
  add column if not exists permissions jsonb not null default '{}'::jsonb;

comment on column profile_locations.permissions is
  'Per-assignment user permission overrides. Top-level keys mirror '
  'shared/permissions.js WEB_PERMISSIONS (e.g. dashboard_business, '
  'whatsapp, settings); mobile.* sub-object mirrors MOBILE_PERMISSIONS. '
  'Empty {} means "fall back to the role default for this assignment''s '
  'role". Resolution order: location feature gate → master bypass → '
  'this column → role default. profiles.permissions is no longer read '
  'as of mig 058.';

-- Smart backfill — preserve current behaviour for single-role users,
-- correct the leak for mixed-role users.
--
-- Only the assignment whose role matches profiles.role gets the
-- copy. For Garrett (owner profile, owner@CCF + staff@Hatch +
-- staff@Stillorgan): CCF owner assignment receives the blob, the
-- two UN1T staff assignments stay '{}'. Role defaults take over for
-- the staff assignments → he sees Today only at UN1T, full access
-- at CCF — exactly what we want.
update profile_locations pl
set permissions = p.permissions
from profiles p
where pl.profile_id = p.id
  and p.permissions is not null
  and p.permissions <> '{}'::jsonb
  and p.role <> 'master'           -- master bypasses tier 2/3 anyway
  and pl.role = p.role;            -- only the matching-role assignment

-- An informational notice that runs once at apply time. The numbers
-- print to the migration log so we can verify the backfill matched
-- the expected user count.
do $$
declare
  total_assignments int;
  backfilled_assignments int;
begin
  select count(*) into total_assignments from profile_locations;
  select count(*) into backfilled_assignments
    from profile_locations where permissions <> '{}'::jsonb;
  raise notice
    'mig 058: % of % profile_locations rows received a permissions backfill',
    backfilled_assignments, total_assignments;
end $$;
