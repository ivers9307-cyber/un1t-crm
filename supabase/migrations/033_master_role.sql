-- 'master' role — global super-admin above 'owner'.
--
-- Powers (enforced server-side):
--   - Create new locations
--   - Create / promote staff with role='owner' or 'master'
--   - See and modify every location's data (RLS short-circuit)
--   - Bypass per-location feature gates and per-user permissions
--
-- Owner is now a STUDIO-level admin: full control of locations
-- they're a member of, but cannot create new locations or new
-- owner/master accounts.
--
-- Multiple masters allowed — they can promote each other.

CREATE OR REPLACE FUNCTION private.auth_is_master()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'master'
  );
$$;

COMMENT ON FUNCTION private.auth_is_master() IS
  'Returns true iff the calling user has role=master. Used by RLS policies and route handlers to grant global access.';

CREATE OR REPLACE FUNCTION private.auth_is_in_location(loc_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT loc_id IS NOT NULL
     AND (
       private.auth_is_master()
       OR EXISTS (
         SELECT 1
           FROM profile_locations
          WHERE profile_id = auth.uid()
            AND location_id = loc_id
       )
     );
$$;

-- Seed: promote richard@richardivers.com to master if currently owner.
-- Idempotent — re-running on a row that's already master is a no-op.
UPDATE profiles
   SET role = 'master',
       updated_at = now()
 WHERE email = 'richard@richardivers.com'
   AND role = 'owner';
