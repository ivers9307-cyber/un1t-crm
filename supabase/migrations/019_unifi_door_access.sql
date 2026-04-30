-- ============================================================
-- 019: UniFi Access door-access integration
--
-- Two new columns on profiles:
--   unifi_door_access  : the toggle. true = sync access policy on save.
--   unifi_user_id      : the UniFi user UUID (returned by their API).
--                        Populated lazily the first time we either
--                        find-by-email or create the user. Persists
--                        across toggling so re-enabling skips the lookup.
--
-- Per-location config lives in locations.settings.unifi (JSONB) — same
-- pattern we already use for Glofox. Expected shape:
--
--   settings.unifi = {
--     "host":              "https://stillorgan-access.un1t.ie:12445",
--     "api_token":         "wHFmHRuX4I7sB2oDkD6wHg",     -- created in
--                                                          UniFi: Access >
--                                                          Settings > General
--                                                          > Advanced > API
--                                                          Token. Scopes
--                                                          needed: view:user,
--                                                          edit:user,
--                                                          view:policy.
--     "staff_policy_id":   "03895c7f-9f53-4334-...",     -- assigned to
--                                                          staff/head_coach.
--                                                          Pre-create in
--                                                          UniFi covering
--                                                          main door + physio
--                                                          office.
--     "manager_policy_id": "3b6bcb0c-7498-44cf-..."      -- assigned to
--                                                          manager+. Covers
--                                                          all staff doors
--                                                          plus main office.
--   }
--
-- We deliberately do not enforce a check constraint on the JSON shape —
-- managers may save a partial config (e.g. host + token only) while
-- they're setting things up, and we treat "fully configured" as
-- staff_policy_id AND manager_policy_id AND host AND api_token all set.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS unifi_door_access BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS unifi_user_id     TEXT;

COMMENT ON COLUMN profiles.unifi_door_access IS
  'When true, the staff member is assigned the location-level UniFi access '
  'policy that matches their role (manager+ → manager_policy_id, otherwise '
  'staff_policy_id). Toggling off revokes all UniFi policies but keeps '
  'unifi_user_id so we can re-assign without another lookup.';

COMMENT ON COLUMN profiles.unifi_user_id IS
  'Identity ID returned by the UniFi Access API for this profile. Set on '
  'first sync via /api/v1/developer/users/search (by email) or POST /users. '
  'Persists even when unifi_door_access flips back to false.';

-- We don't index unifi_user_id (too low-cardinality / point-lookups always
-- happen via profile id). If reverse lookup ever becomes a need, add then.
