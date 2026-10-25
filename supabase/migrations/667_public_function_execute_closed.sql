-- 667 — FNEXECSWEEP.1: no function in public is executable by anon or
-- PUBLIC, authenticated keeps EXECUTE only on the two member-app RPCs, and a
-- NEW function postgres creates in public is executable by postgres +
-- service_role only.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 29 Sep 2026), RE-VERIFIED 30 Sep 2026
-- after migs 664 (TWILIO-RETIRE.1) and 666 (EVENTCONFIRM-WA.1) were applied:
-- the same 106 functions, the same 50/52/47 counts, the same list and the
-- same default ACLs (neither touches a function or a privilege). Since
-- TWILIO-RETIRE.1 the three increment_sms_broadcast_* functions have no
-- caller at all. Numbered 667 because 664 and 666 were taken by those two
-- (665 is an open PR). Proven ahead of apply by
-- tests/migration-667-public-function-execute-closed.test.js (PGlite).
--
-- ===========================================================================
-- THE FINDING (follow-ups C67, found planning C56: F1)
-- ===========================================================================
-- VERIFIED LIVE: of 106 public functions (all owned by postgres), anon could
-- execute 50, authenticated 52, PUBLIC 47:
--   * 20 SECURITY INVOKER server RPCs (counters, queue claims, rollups, a
--     phone normaliser) whose only callers are service-role routes, crons and
--     webhooks (createServerClient). /rest/v1/rpc/* in three 24 h windows:
--     service_role only.
--   * 30 trigger functions (callable only as triggers; a trigger fires
--     without the firing role holding EXECUTE).
--   * list_enabled_integrations() and scan_straps_for_contact(): DEFINER,
--     authenticated + service_role only; the member app calls both signed in.
--     UNCHANGED here.
-- Cause: pg_default_acl for postgres in public grants EXECUTE on every new
-- function to anon, authenticated and service_role, and there is NO global
-- row, so Postgres's built-in PUBLIC EXECUTE applies on top.
--
-- A per-schema "IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC" is
-- a NO-OP (per-schema defaults are ADDED to the global ones and cannot remove
-- them). PUBLIC needs the global form, which reaches every schema postgres
-- creates functions in: private (20 RLS helpers have a NULL ACL and reach
-- authenticated ONLY via PUBLIC) and extensions (pgcrypto, uuid-ossp). Both
-- get PUBLIC re-added per schema: only public changes.
--
-- normalize_ie_wa_phone is called inside the INVOKER trigger derive_wa_phone
-- on contacts. Trigger BODIES are checked as the firing role; contacts has no
-- client INSERT/UPDATE since mig 653, so only service_role (keeps EXECUTE)
-- and postgres-owned DEFINER paths fire it.
--
-- Not changeable by postgres: supabase_admin's own default row for public
-- (anon/authenticated EXECUTE on functions supabase_admin creates there).
-- Today 0 public functions have a non-postgres owner.
--
-- ===========================================================================
-- CONSEQUENCE (CLAUDE.md invariant; tests/function-execute-guard.test.js)
-- ===========================================================================
-- A function a signed-in client calls needs GRANT EXECUTE … TO authenticated
-- in the migration that creates it; every other new public function states
-- REVOKE EXECUTE … FROM PUBLIC, anon, authenticated. DROP + CREATE resets the
-- ACL to this closed default; CREATE OR REPLACE keeps it.
--
-- APPLY: after merge; see
-- docs/superpowers/plans/2026-09-27-followups/C67-FNEXECSWEEP.1.md, Task 5.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- A. The 20 server-only RPCs (service_role keeps its own EXECUTE).
REVOKE EXECUTE ON FUNCTION
  public.bump_presentation_version(uuid, integer),
  public.claim_invoice_analysis_batch(integer),
  public.claim_recon_hunt_batch(integer),
  public.funnel_step_counts(uuid, timestamp with time zone, text),
  public.hyrox_coaches_on_shift(uuid, timestamp with time zone, timestamp with time zone),
  public.increment_car_xero_issue_count(uuid),
  public.increment_email_send_clicks(uuid),
  public.increment_email_send_opens(uuid),
  public.increment_email_ticket_unread(uuid),
  public.increment_instagram_conversation_unread(uuid),
  public.increment_sms_broadcast_delivered(uuid),
  public.increment_sms_broadcast_metric(uuid, text, integer),
  public.increment_sms_broadcast_undelivered(uuid),
  public.increment_whatsapp_broadcast_metric(uuid, text, integer),
  public.increment_whatsapp_conversation_unread(uuid),
  public.increment_whatsapp_template_sent(uuid, integer),
  public.normalize_ie_wa_phone(text),
  public.record_bca_event(uuid, text, timestamp with time zone),
  public.upsert_supplier_default(uuid, text, text, text, text, text),
  public.whatsapp_spend_rollup(uuid, timestamp with time zone)
FROM PUBLIC, anon, authenticated;

-- B. The 30 trigger functions with the full default ACL.
REVOKE EXECUTE ON FUNCTION
  public.auto_unsubscribe_classpass(),
  public.campaigns_block_sent_delete(),
  public.campaigns_lock_sent_content(),
  public.checklist_instances_touch_updated_at(),
  public.checklist_templates_touch_updated_at(),
  public.derive_wa_phone(),
  public.equipment_touch_updated_at(),
  public.fte_expense_claims_touch_updated_at(),
  public.host_campaigns_block_sent_delete(),
  public.invoices_queue_touch_updated_at(),
  public.issues_touch_updated_at(),
  public.log_wa_message_to_timeline(),
  public.policies_set_updated_at(),
  public.reset_email_status_on_address_change(),
  public.shift_assignments_warn_overlap(),
  public.sms_broadcasts_set_updated_at(),
  public.stamp_deal_stage_entered(),
  public.sync_activity_done_status(),
  public.tg_contractor_invoices_validate_period(),
  public.touch_achievement_rules_updated_at(),
  public.touch_contact_devices_updated_at(),
  public.touch_contact_goals_updated_at(),
  public.touch_hr_provider_connections_updated_at(),
  public.touch_service_integrations_updated_at(),
  public.update_holiday_allowance(),
  public.update_updated_at(),
  public.xero_accounts_touch_updated_at(),
  public.xero_contacts_touch_updated_at(),
  public.xero_supplier_defaults_touch_updated_at(),
  public.xero_tax_rates_touch_updated_at()
FROM PUBLIC, anon, authenticated;

-- C. The default for functions postgres creates.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extensions GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text. Any failure raises and the
-- whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
  v_keep oid[] := ARRAY['public.list_enabled_integrations()'::regprocedure::oid,
                        'public.scan_straps_for_contact()'::regprocedure::oid];
  v_oid oid;
  v_role text;
  v_schema text;
  v_sig text;
BEGIN
  -- 1. anon: no function in public (follows role membership and PUBLIC, and
  --    sees another grantor's grant).
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 667: anon can still execute: %', v_bad;
  END IF;

  -- 2. authenticated: exactly the member-app RPCs.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND p.oid <> ALL (v_keep);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 667: authenticated can execute functions outside the keep list: %', v_bad;
  END IF;
  FOREACH v_oid IN ARRAY v_keep LOOP
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 667: authenticated lost EXECUTE on % (the member app calls it signed in)', v_oid::regprocedure;
    END IF;
  END LOOP;

  -- 3. PUBLIC: no ACL item anywhere in public (a NULL ACL means the built-in
  --    default, which includes PUBLIC).
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 667: PUBLIC still holds EXECUTE on: %', v_bad;
  END IF;

  -- 4. The server path: service_role still executes every public function.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 667: service_role cannot execute: %', v_bad;
  END IF;

  -- 5. The default, by behaviour: create a probe in each schema, ask, drop.
  FOREACH v_schema IN ARRAY ARRAY['public', 'private', 'extensions'] LOOP
    v_sig := format('%I._mig667_default_probe()', v_schema);
    EXECUTE format('DROP FUNCTION IF EXISTS %I._mig667_default_probe()', v_schema);
    EXECUTE format('CREATE FUNCTION %I._mig667_default_probe() RETURNS integer LANGUAGE sql IMMUTABLE AS %L', v_schema, 'SELECT 1');
    IF v_schema = 'public' THEN
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
        IF has_function_privilege(v_role, v_sig, 'EXECUTE') THEN
          RAISE EXCEPTION 'mig 667: a new function in public is still executable by %', v_role;
        END IF;
      END LOOP;
      IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'mig 667: a new function in public is not executable by service_role (every new server RPC would 42501)';
      END IF;
    ELSIF NOT has_function_privilege('public', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 667: a new function in % lost the PUBLIC default (RLS helpers / extension functions created later would refuse clients)', v_schema;
    END IF;
    EXECUTE format('DROP FUNCTION %I._mig667_default_probe()', v_schema);
  END LOOP;

  RAISE NOTICE 'mig 667: anon executes nothing in public; authenticated only list_enabled_integrations() and scan_straps_for_contact(); new public functions start service_role-only.';
END $$;

COMMIT;
