-- 054_cron_health_security_invoker.sql
-- Follow-up to 053. The security advisor flagged public.cron_health as
-- SECURITY DEFINER (Supabase's default for postgres-owned views). That
-- bypasses RLS on the underlying cron_heartbeats table, which has
-- deny-all policies for anon/authenticated. With SECURITY DEFINER on,
-- those denies are useless — anyone with SELECT on the view sees the
-- rows.
--
-- security_invoker = on flips it: the view runs with the querying
-- role's permissions, so RLS on cron_heartbeats applies. Service role
-- bypasses RLS as before, so /api/cron/health-check still works
-- normally; anon/authenticated see nothing.

ALTER VIEW public.cron_health SET (security_invoker = on);
