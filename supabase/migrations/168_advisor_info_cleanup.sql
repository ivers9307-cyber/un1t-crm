-- ============================================================
-- 168: SEC.2 — Clear INFO advisor flags + document permanent exceptions
-- ============================================================
--
-- Two-part cosmetic cleanup, no behaviour change:
--
--   (1) Add one RESTRICTIVE qual=false policy to each of the 5
--       service-role-only tables flagged by rls_enabled_no_policy.
--       RESTRICTIVE policies are AND'd with permissive results;
--       since these tables have ZERO permissive policies, the
--       restrictive is never evaluated at query time. Net effect:
--       advisor lint clears, runtime cost is unchanged.
--       Tables: ac_sessions, contractor_invoices, cron_heartbeats,
--               glofox_webhook_events, webhook_events.
--
--   (2) COMMENT ON FUNCTION for the 2 SECURITY DEFINER functions
--       that remain authenticated-callable as documented exceptions.
--       The advisor still flags them (no way to clear without
--       breaking functionality), but the comment explains why to
--       anyone reading the schema.
--
-- auth_leaked_password_protection (HIBP) stays unaddressed —
-- requires Supabase Pro plan.

BEGIN;

CREATE POLICY "no_anon_or_authenticated_access" ON public.ac_sessions
  AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "no_anon_or_authenticated_access" ON public.contractor_invoices
  AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "no_anon_or_authenticated_access" ON public.cron_heartbeats
  AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "no_anon_or_authenticated_access" ON public.glofox_webhook_events
  AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "no_anon_or_authenticated_access" ON public.webhook_events
  AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

COMMENT ON FUNCTION public.list_enabled_integrations() IS
'Intentional SECURITY DEFINER — reads from public.service_integrations '
'(which holds OAuth client_id + client_secret behind RLS) and returns a '
'redacted projection of just (provider, display_name) for the enabled '
'integrations. The integrations settings UI calls this from authenticated '
'context; switching to SECURITY INVOKER would hit RLS on '
'service_integrations and return zero rows. Advisor warning is a '
'documented exception, not an issue. SEC.2 mig 168.';

COMMENT ON FUNCTION public.scan_straps_for_contact() IS
'Intentional SECURITY DEFINER — reads ble_bridges.last_seen_straps '
'across all bridges (cross-location) so the champ-app /account/devices '
'flow can show nearby chest-strap MACs for pairing. Switching to '
'SECURITY INVOKER would hide bridges from authenticated callers who '
'aren''t members of every bridge''s location. Function scopes its '
'output to the caller''s contact via private.auth_contact_id() at the '
'top. Advisor warning is a documented exception, not an issue. SEC.2 '
'mig 168.';

COMMIT;
