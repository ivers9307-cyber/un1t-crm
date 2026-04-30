-- ============================================================
-- 022: Clear the final cluster of advisor warnings
--
-- Three sections, each independent:
--
--   A. Move the auth_* helpers out of `public` into a new `private`
--      schema. RLS policies referencing them by OID survive the move
--      unchanged (Postgres stores function references by OID, not by
--      schema-qualified text). Net effect: PostgREST stops exposing
--      them at /rest/v1/rpc/* — clearing five WARN findings — while
--      RLS evaluation continues to work because authenticated still
--      has EXECUTE on each function (preserved across SET SCHEMA) and
--      now has USAGE on the new schema.
--
--   B. Drop the `Public read access for branding` policy on
--      storage.objects. The bucket stays public, so anonymous clients
--      can still GET known object URLs (e.g. company logos rendered
--      in marketing emails). What they lose is the ability to LIST
--      the bucket — and we never list (verified: only call sites are
--      .upload() server-side and .getPublicUrl() which doesn't need
--      a SELECT policy on a public bucket).
--
--   C. Add an explicit deny-all RLS policy on rate_limit_buckets.
--      The table is meant to be service-role-only; service role
--      bypasses RLS regardless, so the policy is purely declarative —
--      it makes the intent ("no anon or authenticated should ever
--      read or write this") explicit and silences the
--      rls_enabled_no_policy INFO finding.
--
-- One outstanding item this migration cannot fix:
--   Leaked-password protection (HaveIBeenPwned check on signup) —
--   Supabase Auth setting, no SQL surface. Toggle in the dashboard:
--     Auth → Policies → Password security → Leaked password protection.
-- ============================================================


-- ============================================================
-- A. Move auth helpers to a private schema (PostgREST won't expose them)
-- ============================================================

CREATE SCHEMA IF NOT EXISTS private;
COMMENT ON SCHEMA private IS
  'Internal helpers not exposed via PostgREST. Functions placed here are '
  'still callable from RLS expressions and triggers but do not appear at '
  '/rest/v1/rpc/*. Used for auth_* SECURITY DEFINER helpers that need '
  'to bypass RLS to read profiles/profile_locations.';

-- Authenticated needs USAGE on the schema to call functions through RLS.
-- Anon does NOT — by design. Service role bypasses everything.
GRANT USAGE ON SCHEMA private TO authenticated;

-- Move each helper. ALTER FUNCTION ... SET SCHEMA preserves OIDs and
-- existing grants, so RLS policies and migration 014's GRANT TO
-- authenticated continue to apply unchanged.
ALTER FUNCTION public.auth_is_in_location(UUID)        SET SCHEMA private;
ALTER FUNCTION public.auth_role()                       SET SCHEMA private;
ALTER FUNCTION public.auth_is_owner_or_manager()        SET SCHEMA private;
ALTER FUNCTION public.auth_is_owner()                   SET SCHEMA private;
ALTER FUNCTION public.get_user_role(UUID)               SET SCHEMA private;


-- ============================================================
-- B. Stop the branding bucket allowing listing
-- ============================================================

-- Public URLs (https://<proj>.supabase.co/storage/v1/object/public/branding/<file>)
-- continue to work for known paths because the bucket is public. The
-- only thing this policy controlled was anon/authenticated SELECT on
-- storage.objects, which manifests as bucket listing. We don't list
-- in app code (verified — only .upload() server-side + .getPublicUrl()
-- calls), so dropping the policy is safe.
DROP POLICY IF EXISTS "Public read access for branding" ON storage.objects;


-- ============================================================
-- C. Explicit deny-all on rate_limit_buckets (intent-only)
-- ============================================================

-- Service role bypasses RLS, so this policy never actually blocks
-- anything in production paths. It exists to (a) make the access
-- model explicit ("no end-user role should ever touch this table")
-- and (b) clear the rls_enabled_no_policy advisor finding.
CREATE POLICY rate_limit_buckets_deny_end_users ON rate_limit_buckets
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);


-- ============================================================
-- VERIFICATION (run manually after applying)
--
--   -- A: functions should now live in `private`, with authenticated
--   --    + service_role having EXECUTE.
--   SELECT n.nspname, p.proname, p.proacl
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE p.proname IN ('auth_is_in_location','auth_role','auth_is_owner',
--                        'auth_is_owner_or_manager','get_user_role');
--   -- Expect five rows with nspname='private'.
--
--   -- A bis: confirm RLS still works — pick a test profile + matching
--   -- location_id, set request.jwt.claim.sub to that profile, and read
--   -- contacts. Should return only that location's rows.
--
--   -- B: zero rows for the dropped policy.
--   SELECT policyname FROM pg_policies
--    WHERE schemaname = 'storage'
--      AND tablename = 'objects'
--      AND policyname = 'Public read access for branding';
--
--   -- C: should show the new policy.
--   SELECT policyname, qual, with_check
--     FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'rate_limit_buckets';
-- ============================================================
