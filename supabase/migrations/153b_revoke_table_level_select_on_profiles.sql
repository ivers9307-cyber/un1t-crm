-- SECURITY.1 phase 2 (corrected) — column-level REVOKE on profiles
-- didn't take effect because Supabase grants table-level SELECT on
-- profiles to authenticated + anon, and Postgres column-level
-- REVOKE is silently ignored when a table-level GRANT exists.
-- Verified empirically with information_schema.column_privileges
-- straight after mig 153.
--
-- Corrected approach: REVOKE the table-level SELECT entirely. The
-- 2026-05-13 audit confirmed ZERO client-side reads of profiles —
-- every profile read path uses createServerClient (service_role)
-- which bypasses GRANTs entirely. So revoking table SELECT for the
-- authenticated + anon roles breaks nothing in the codebase today
-- AND closes the comp-column leak completely.
--
-- Bonus: this also future-proofs against any new sensitive column
-- being added to profiles later — they'd be invisible to client-side
-- queries by default rather than requiring per-column REVOKEs.

REVOKE SELECT ON profiles FROM authenticated;
REVOKE SELECT ON profiles FROM anon;

-- Keep INSERT/UPDATE/DELETE alone — none are needed by client-side
-- today, but we don't want to break any indirect path (e.g. an RLS
-- policy that does an INSERT trigger). The leak we're closing is
-- SELECT-only.

-- Sanity check the result.
DO $$
DECLARE
  bad_grants INT;
BEGIN
  SELECT COUNT(*) INTO bad_grants
  FROM information_schema.table_privileges
  WHERE table_name = 'profiles'
    AND grantee IN ('authenticated', 'anon')
    AND privilege_type = 'SELECT';
  IF bad_grants > 0 THEN
    RAISE EXCEPTION 'SECURITY.1: still % table-level SELECT grants on profiles to authenticated/anon', bad_grants;
  END IF;
  RAISE NOTICE 'SECURITY.1 mig 153b: table-level SELECT on profiles revoked from authenticated + anon.';
END $$;
