-- ============================================================
-- 166: SEC.1 — Address remaining Supabase security WARN advisor flags
-- ============================================================
--
-- Three categories of WARN, all addressed in one migration:
--
--   (1) function_search_path_mutable (8 fns) — pin search_path to
--       'pg_catalog, public' so a malicious schema earlier in the
--       caller's search path can't shadow built-ins. pg_catalog +
--       public keeps unqualified table references working.
--
--   (2) anon/authenticated SECURITY DEFINER callable — 6 trigger
--       fns (never meant to be RPC) + 2 service-role-only RPCs
--       (increment_campaign_metric, recalculate_campaign_stats).
--       REVOKE EXECUTE from PUBLIC, anon, authenticated; service_role
--       keeps its explicit grant. Trigger fns still fire from their
--       triggers — REVOKE only affects /rest/v1/rpc/* exposure.
--
--   (3) rls_policy_always_true on booking_reminder_sends — drop the
--       "Service role full access" policy (qual=true, roles=public).
--       Same security smell + perf cost we fixed on other tables in
--       PERF.1. The 'booking_reminder_sends readable' policy stays
--       for authenticated reads; service_role bypasses RLS.
--
-- Not fixed here (documented exceptions):
--   - list_enabled_integrations + scan_straps_for_contact authenticated
--     callability — these ARE intentional RPCs; lint stays as known
--     documented exception. Functions are SECURITY DEFINER because
--     they expose redacted summaries across RLS-restricted tables.
--   - auth_leaked_password_protection — Supabase Auth dashboard toggle,
--     not SQL. Operator needs to enable HIBP check in the dashboard.
--   - 5 INFO-level rls_enabled_no_policy (ac_sessions / contractor_invoices /
--     cron_heartbeats / glofox_webhook_events / webhook_events) —
--     cosmetic; tables are service-role-only by design and INFO is
--     below WARN. Adding restrictive deny policies would clear the lint
--     without changing behaviour; left for now to keep policy count low.

BEGIN;

ALTER FUNCTION public.increment_sms_broadcast_delivered SET search_path = 'pg_catalog', 'public';
ALTER FUNCTION public.increment_sms_broadcast_undelivered SET search_path = 'pg_catalog', 'public';
ALTER FUNCTION public.tg_contractor_invoices_validate_period() SET search_path = 'pg_catalog', 'public';
ALTER FUNCTION public.sms_broadcasts_set_updated_at() SET search_path = 'pg_catalog', 'public';
ALTER FUNCTION public.touch_hr_provider_connections_updated_at() SET search_path = 'pg_catalog', 'public';
ALTER FUNCTION public.touch_contact_devices_updated_at() SET search_path = 'pg_catalog', 'public';
ALTER FUNCTION public.auto_unsubscribe_classpass() SET search_path = 'pg_catalog', 'public';
ALTER FUNCTION public.sync_activity_done_status() SET search_path = 'pg_catalog', 'public';

REVOKE EXECUTE ON FUNCTION public.handle_booking_status_change()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.shift_assignments_mirror_to_shifts()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.shift_blocks_cleanup_legacy_shifts()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.shifts_mirror_to_assignments()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_contacts_email_marketing()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_contacts_pipeline_stage_slug()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.increment_campaign_metric(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recalculate_campaign_stats(uuid)
  FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Service role full access" ON public.booking_reminder_sends;

COMMIT;
