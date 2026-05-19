-- UNIFI-DOORS-SCOPE — per-user per-location door allowlist for the
-- Studio Management remote-unlock feature.
--
-- Previously: /api/studio-management/doors returned every door from
-- the UniFi controller to anyone with the studio_management permission
-- at the location. A staff user with a restricted UniFi physical-access
-- policy ("staff main + physio") would still see every door in the CRM
-- UI, including doors their card couldn't unlock anyway.
--
-- New model: a separate CRM-side allowlist. Each profile_locations
-- row carries an array of door IDs the user is allowed to remote-
-- unlock from the iOS Studio Management screen. The studio doors
-- endpoint filters to this set; the unlock endpoint refuses calls
-- against doors not in the set.
--
-- This decouples CRM remote-unlock authorisation from UniFi's
-- physical-access policy entirely. UniFi's policy still controls
-- what a card physically unlocks at the reader; the CRM's allowlist
-- controls what shows up in the app. The two can diverge intentionally
-- (e.g. a manager whose card opens every door but who only sees the
-- main + bin-store door in the app to keep the UI focused).
--
-- Backfill policy:
--   • staff / head_coach / contractor → empty array. They must be
--     explicitly granted doors through the staff edit screen.
--     This is the security tightening that resolves Lucy's case.
--   • manager / owner / master → NULL (sentinel for "no override —
--     legacy fallback: show all doors at the location"). They keep
--     seeing everything they saw before; the route treats NULL as
--     unrestricted for those roles.
--
-- The two-tier default avoids a hard cut-over: no manager loses
-- functionality on deploy day, but staff are immediately scoped.
-- Operators can tighten managers later by populating the array.

set check_function_bodies = off;

alter table public.profile_locations
  add column if not exists unifi_door_ids text[];

comment on column public.profile_locations.unifi_door_ids is
  'UNIFI-DOORS-SCOPE — CRM-side allowlist of UniFi Access door IDs '
  'this user can remote-unlock from the Studio Management screen at '
  'this location. NULL = legacy fallback (route shows all doors for '
  'manager+ roles only). Empty array = no doors visible. Populated = '
  'exactly those doors. UniFi policy still gates the physical unlock '
  'at the reader; this only controls the in-app UI surface.';

-- ====================================================================
-- Backfill
-- ====================================================================

-- Empty array for the restricted roles. Setting to '{}' rather than
-- NULL is what triggers the strict-filter path in the studio doors
-- route. Operators must now go to staff edit and tick the doors
-- each member is allowed to see.
update public.profile_locations pl
   set unifi_door_ids = '{}'
  from public.profiles p
 where pl.profile_id = p.id
   and pl.unifi_door_ids is null
   and (
     -- Per-location role overrides the global profile role for this
     -- decision — a user can be a manager elsewhere but a staffer here.
     coalesce(pl.role, p.role) in ('staff', 'head_coach', 'contractor')
   );

-- manager / owner / master rows keep unifi_door_ids = NULL so the
-- route surfaces all doors for them. Explicit no-op for clarity.

-- ====================================================================
-- Filter index for the studio doors endpoint
-- ====================================================================
--
-- The route reads (profile_id, location_id) and uses unifi_door_ids
-- to filter — both columns already exist as the primary key of
-- profile_locations, so no new index is needed. This comment is left
-- as a load-bearing note for the reviewer.
