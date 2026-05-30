-- 221_advisor_safe_cleanup.sql
--
-- ADVISOR-CLEANUP.1 — fixes for Supabase security + performance advisor
-- warnings. Already applied to the live DB via the Supabase MCP on
-- 2026-05-30; committed here so schema-as-code matches production.
--
-- Scope (only the unambiguously-safe items — see notes below for what
-- was deliberately NOT changed):
--   • 6 unindexed foreign keys  → add covering indexes (perf advisor)
--   • 9 trigger helper functions → pin empty search_path (lint 0011)
--   • fte_expense_recompute_totals → revoke EXECUTE from PUBLIC (lint 0028/0029)
--
-- NOT changed (intentional, documented):
--   • list_enabled_integrations / scan_straps_for_contact remain
--     EXECUTE-able by `authenticated` — they're called by champ-app
--     (see mig 216 notes) and self-scope via private.auth_contact_id().
--   • RLS auth.*() init-plan: already wrapped as (select auth.uid())
--     by the earlier P1 work — nothing left to do.
--   • 191 "unused index" advisories: left in place (idx_scan=0 = not
--     used since last stats reset, not proof of waste); zero exact
--     duplicates exist to drop.
--   • 10 rls_enabled_no_policy (INFO): these tables are service-role
--     only by design — RLS on with no policy = deny-all to anon/auth,
--     which is the intended posture. Left as-is.
--   • auth_leaked_password_protection: a Supabase dashboard toggle,
--     not SQL — enable under Auth → Policies if wanted.

-- (a) covering indexes for unindexed FKs
CREATE INDEX IF NOT EXISTS idx_api_keys_created_by              ON public.api_keys (created_by);
CREATE INDEX IF NOT EXISTS idx_checklist_instances_template_id  ON public.checklist_instances (template_id);
CREATE INDEX IF NOT EXISTS idx_issue_attachments_uploaded_by    ON public.issue_attachments (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_issues_resolved_by               ON public.issues (resolved_by);
CREATE INDEX IF NOT EXISTS idx_location_trusted_ips_created_by  ON public.location_trusted_ips (created_by);
CREATE INDEX IF NOT EXISTS idx_studio_devices_paired_by         ON public.studio_devices (paired_by);

-- (b) pin search_path on trigger helpers
ALTER FUNCTION public.checklist_templates_touch_updated_at()    SET search_path = '';
ALTER FUNCTION public.checklist_instances_touch_updated_at()    SET search_path = '';
ALTER FUNCTION public.fte_expense_claims_touch_updated_at()     SET search_path = '';
ALTER FUNCTION public.policies_set_updated_at()                 SET search_path = '';
ALTER FUNCTION public.invoices_queue_touch_updated_at()         SET search_path = '';
ALTER FUNCTION public.xero_accounts_touch_updated_at()          SET search_path = '';
ALTER FUNCTION public.xero_contacts_touch_updated_at()          SET search_path = '';
ALTER FUNCTION public.xero_supplier_defaults_touch_updated_at() SET search_path = '';
ALTER FUNCTION public.issues_touch_updated_at()                SET search_path = '';

-- (c) close the RPC exposure on the trigger-only recompute helper
REVOKE EXECUTE ON FUNCTION public.fte_expense_recompute_totals() FROM PUBLIC, anon, authenticated;
