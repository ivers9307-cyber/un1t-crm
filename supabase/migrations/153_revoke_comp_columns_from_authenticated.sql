-- SECURITY.1 phase 2 — REVOKE column-level SELECT on the 5
-- deprecated comp columns from the authenticated + anon Supabase
-- roles. This is the actual lock on the data: even if a staff
-- member opens devtools and issues a direct Supabase JS query
-- against their own profile row, those columns will fail with
-- "permission denied for column".
--
-- Why this is safe:
--   - service_role (createServerClient) bypasses column GRANTs
--     entirely — every server-side code path continues to read
--     the columns unchanged. Dual-write still works because
--     UPDATE goes via service_role too.
--   - Audit on 2026-05-13: 0 client-side queries against
--     profiles in the entire codebase. Every profile read is
--     server-side. No createBrowserClient code touches profiles.
--   - RLS policies on profiles continue to evaluate their
--     USING / WITH CHECK expressions because policies run with
--     table-owner privileges, not caller's.
--   - Triggers similarly run with definer privileges.
--
-- NOTE: this migration was a no-op in practice — Postgres
-- column-level REVOKE is silently ignored when a table-level
-- GRANT exists for the same role (Supabase grants
-- `SELECT ON profiles TO authenticated` table-wide). The
-- effective lockdown is in mig 153b which REVOKEs the
-- table-level SELECT entirely.

REVOKE SELECT (
  annual_salary,
  hourly_rate,
  contracted_hours_per_week,
  annual_leave_entitlement,
  overtime_rate
) ON profiles FROM authenticated;

REVOKE SELECT (
  annual_salary,
  hourly_rate,
  contracted_hours_per_week,
  annual_leave_entitlement,
  overtime_rate
) ON profiles FROM anon;

-- Reinforce the deprecated tag on the columns with a note about
-- the access path.
COMMENT ON COLUMN profiles.annual_salary IS
  'DEPRECATED (mig 152) → profile_compensation.annual_salary. SELECT revoked from authenticated+anon (mig 153b) — only service_role can read. To be dropped in phase 3.';
COMMENT ON COLUMN profiles.hourly_rate IS
  'DEPRECATED (mig 152) → profile_compensation.hourly_rate. SELECT revoked from authenticated+anon (mig 153b) — only service_role can read. To be dropped in phase 3.';
COMMENT ON COLUMN profiles.contracted_hours_per_week IS
  'DEPRECATED (mig 152) → profile_compensation.contracted_hours_per_week. SELECT revoked from authenticated+anon (mig 153b) — only service_role can read. To be dropped in phase 3.';
COMMENT ON COLUMN profiles.annual_leave_entitlement IS
  'DEPRECATED (mig 152) → profile_compensation.annual_leave_entitlement. SELECT revoked from authenticated+anon (mig 153b) — only service_role can read. To be dropped in phase 3.';
COMMENT ON COLUMN profiles.overtime_rate IS
  'DEPRECATED (mig 152) → profile_compensation.overtime_rate. SELECT revoked from authenticated+anon (mig 153b) — only service_role can read. To be dropped in phase 3.';
