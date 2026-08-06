-- 490 — revoke public EXECUTE on the mig 489 trigger functions (LOCCOMMS.2).
--
-- Mig 489 created both functions SECURITY DEFINER without revoking the default
-- PUBLIC grant, so Supabase exposed them over PostgREST and the security
-- advisor flagged both at WARN — including the anon variant
-- (`anon_security_definer_function_executable`), i.e. callable WITHOUT signing
-- in, via /rest/v1/rpc/sync_contact_location_preferences.
--
-- They are trigger functions. Nothing should ever call them over the API, and
-- the repo already established this pattern: create_contact_preferences (mig
-- 005) and sync_contacts_email_marketing (mig 155) are both SECURITY DEFINER
-- with an ACL of exactly `postgres | service_role`. This brings 489's functions
-- into line.
--
-- SECURITY DEFINER is retained deliberately: the OFF-propagation branch updates
-- contact_location_preferences rows at EVERY location a contact belongs to, and
-- under SECURITY INVOKER an RLS-bound caller who can only see their own
-- locations would silently update a subset — an unsubscribe that half-applies.
--
-- Revoking EXECUTE does not stop the triggers: Postgres checks function
-- privileges at CREATE TRIGGER time, not on each fire. Verified live after
-- applying — a fresh contact still gets its location row.

revoke execute on function create_contact_location_preferences() from public;
revoke execute on function create_contact_location_preferences() from anon;
revoke execute on function create_contact_location_preferences() from authenticated;

revoke execute on function sync_contact_location_preferences() from public;
revoke execute on function sync_contact_location_preferences() from anon;
revoke execute on function sync_contact_location_preferences() from authenticated;
