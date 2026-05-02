-- ============================================================
-- 051: Per-location roles (Phase 1 — data model + helpers)
--
-- Lets a user hold different roles at different studios — e.g.
-- owner at Hatch Street and head_coach at Stillorgan, with
-- independent visibility/rights at each.
--
-- Phase 1 is intentionally additive and behaviour-preserving:
--
--   1. Add `profile_locations.role`, backfill from
--      `profiles.role` so every existing assignment keeps the
--      role the user already had.
--   2. Add per-location helpers (`*_at(loc_id)`) for the new
--      RLS policies that Phase 2 will introduce.
--   3. Update the existing global helpers to derive from the
--      per-location data — same input, same output for any
--      currently-deployed user, but ready for the future where
--      a user has more than one role.
--
-- master stays platform-wide. `profiles.role = 'master'` is the
-- master flag; `profile_locations.role` may NEVER be 'master'.
-- A master assigned to a location gets backfilled as 'owner'
-- there so any per-location resolution falls through cleanly.
-- ============================================================

BEGIN;

-- 1. Add the column + backfill
ALTER TABLE public.profile_locations
  ADD COLUMN IF NOT EXISTS role TEXT;

UPDATE public.profile_locations pl
SET role = CASE
  WHEN p.role = 'master' THEN 'owner'
  ELSE p.role
END
FROM public.profiles p
WHERE pl.profile_id = p.id
  AND pl.role IS NULL;

ALTER TABLE public.profile_locations
  ALTER COLUMN role SET NOT NULL;

ALTER TABLE public.profile_locations
  ADD CONSTRAINT profile_locations_role_check
  CHECK (role IN ('owner','manager','head_coach','staff'));

-- 2. Index for "who is <role> at <location>" lookups
CREATE INDEX IF NOT EXISTS idx_profile_locations_location_role
  ON public.profile_locations (location_id, role);

-- 3. New per-location helpers
CREATE OR REPLACE FUNCTION private.get_user_role_at(
  p_user_id UUID,
  p_location_id UUID
) RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT role
  FROM public.profile_locations
  WHERE profile_id = p_user_id
    AND location_id = p_location_id
$$;

CREATE OR REPLACE FUNCTION private.auth_is_owner_at(
  p_location_id UUID
) RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.auth_is_master()
  OR EXISTS (
    SELECT 1 FROM public.profile_locations pl
    WHERE pl.profile_id = (SELECT auth.uid())
      AND pl.location_id = p_location_id
      AND pl.role = 'owner'
  )
$$;

CREATE OR REPLACE FUNCTION private.auth_is_admin_at(
  p_location_id UUID
) RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.auth_is_master()
  OR EXISTS (
    SELECT 1 FROM public.profile_locations pl
    WHERE pl.profile_id = (SELECT auth.uid())
      AND pl.location_id = p_location_id
      AND pl.role IN ('owner','manager')
  )
$$;

CREATE OR REPLACE FUNCTION private.auth_is_manager_at(
  p_location_id UUID
) RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.auth_is_master()
  OR EXISTS (
    SELECT 1 FROM public.profile_locations pl
    WHERE pl.profile_id = (SELECT auth.uid())
      AND pl.location_id = p_location_id
      AND pl.role IN ('owner','manager','head_coach')
  )
$$;

GRANT EXECUTE ON FUNCTION private.get_user_role_at(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.auth_is_owner_at(UUID)       TO authenticated;
GRANT EXECUTE ON FUNCTION private.auth_is_admin_at(UUID)       TO authenticated;
GRANT EXECUTE ON FUNCTION private.auth_is_manager_at(UUID)     TO authenticated;

-- 4. Update existing global helpers (preserve parameter names)
CREATE OR REPLACE FUNCTION private.auth_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (SELECT role FROM public.profiles WHERE id = (SELECT auth.uid())) = 'master'
      THEN 'master'
    ELSE COALESCE(
      (
        SELECT role FROM public.profile_locations pl
        WHERE pl.profile_id = (SELECT auth.uid())
        ORDER BY CASE pl.role
          WHEN 'owner'      THEN 1
          WHEN 'manager'    THEN 2
          WHEN 'head_coach' THEN 3
          WHEN 'staff'      THEN 4
        END
        LIMIT 1
      ),
      (SELECT role FROM public.profiles WHERE id = (SELECT auth.uid()))
    )
  END
$$;

-- Param name kept as `user_id` (Postgres won't let us rename
-- input parameters via CREATE OR REPLACE — would need a DROP).
CREATE OR REPLACE FUNCTION private.get_user_role(user_id UUID)
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (SELECT role FROM public.profiles WHERE id = user_id) = 'master'
      THEN 'master'
    ELSE COALESCE(
      (
        SELECT role FROM public.profile_locations pl
        WHERE pl.profile_id = user_id
        ORDER BY CASE pl.role
          WHEN 'owner'      THEN 1
          WHEN 'manager'    THEN 2
          WHEN 'head_coach' THEN 3
          WHEN 'staff'      THEN 4
        END
        LIMIT 1
      ),
      (SELECT role FROM public.profiles WHERE id = user_id)
    )
  END
$$;

CREATE OR REPLACE FUNCTION private.auth_is_owner()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.auth_role() = 'owner'
$$;

CREATE OR REPLACE FUNCTION private.auth_is_owner_or_manager()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.auth_role() IN ('owner','manager')
$$;

CREATE OR REPLACE FUNCTION private.auth_is_master()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'master'
  )
$$;

CREATE OR REPLACE FUNCTION private.auth_is_in_location(loc_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT loc_id IS NOT NULL
    AND (
      private.auth_is_master()
      OR EXISTS (
        SELECT 1 FROM public.profile_locations
        WHERE profile_id = (SELECT auth.uid())
          AND location_id = loc_id
      )
    )
$$;

COMMIT;
