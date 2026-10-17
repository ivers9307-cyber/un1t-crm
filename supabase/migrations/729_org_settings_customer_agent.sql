-- 729_org_settings_customer_agent.sql
-- MIAORG.1 — Mia's settings at ORGANISATION level. One blob per organisation,
-- the same shape as locations.settings.customer_agent (src/lib/agent/
-- settings-contract.js), resolved under each studio's own blob by
-- resolveAgentSettings (src/lib/agent/settings-resolve.js):
--   DEFAULTS <- org_settings.customer_agent <- locations.settings.customer_agent
-- The studio-only keys (enabled, test_mode, test_phones, booking_mode, ...) are
-- never inherited from here, so a value in this column can never switch Mia on
-- at a studio.
-- NULL = the organisation sets nothing, so every studio resolves exactly as it
-- did before this column existed. No default, no backfill.
-- DECISION (recorded here): org_settings_select (mig 317/320) lets every member
-- of the organisation read this table, so this column holds COPY AND TUNING
-- ONLY (tone, rules, customer texts, limits, follow-up timings). It must never
-- hold a secret or a credential.
-- column-grant: org_settings carries table-level SELECT for authenticated, so
-- no column grant is needed; no table or column privilege changes.
--
-- WRITE FENCE (final review, Important 1). `authenticated` holds table-level
-- INSERT/UPDATE/DELETE on org_settings, and org_settings_ins / org_settings_upd
-- (mig 320) admit a master or ANY studio owner in the organisation. A new
-- column inherits that, so without a fence an owner could write the org layer
-- straight from the browser, past the route's admin check (resolveAdminOrgId:
-- masters and org admins only), its validation and its refusals; for example
-- `handoff_after_verify_failures: 0` would switch off every studio's
-- verify-fail safety net. Revoking the column's UPDATE is not available: a
-- column-level REVOKE is ignored while the table-level grant stands (CLAUDE.md,
-- mig 153), and taking the table grant away would break the existing owner
-- branding writes this file does not own. So a BEFORE INSERT OR UPDATE trigger
-- refuses a change to customer_agent from any session that is not the server:
--   * INSERT with customer_agent NOT NULL, or
--   * UPDATE where customer_agent IS DISTINCT FROM its old value,
-- unless current_user is service_role (every /api route: createServerClient),
-- postgres (migrations, the Supabase MCP, the SQL editor) or supabase_admin.
-- current_user is the role the statement runs as: PostgREST connects as
-- authenticator and SET ROLEs to the JWT's role (anon / authenticated /
-- service_role), so a browser session is `authenticated` here and cannot
-- claim otherwise (request.jwt.claims is not consulted). The function is
-- SECURITY INVOKER, so current_user is the firing role, not the owner.
-- Other columns are untouched by the fence: an owner's branding write that
-- leaves customer_agent alone (an upsert carries the old value through) still
-- passes, exactly as before. (That owners can write the branding, legal and
-- cap columns from the browser at all is pre-existing and out of scope here.)
-- Precedent for the shape (a BEFORE INSERT OR UPDATE trigger in private that
-- RAISEs, search_path pinned, EXECUTE revoked): mig 622
-- private.refuse_tombstone_access_row. No migration before this one checks
-- the session role in a trigger; this is the first.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.org_settings ADD COLUMN IF NOT EXISTS customer_agent jsonb;
COMMENT ON COLUMN public.org_settings.customer_agent IS
  'MIAORG.1 (mig 729): organisation-level Mia defaults, same shape as locations.settings.customer_agent; studio-only keys are never read from here. NULL = none set. Readable by every org member through org_settings_select, so copy and tuning only, no secrets. Written only by the server (service_role): org_settings_customer_agent_fence refuses a client write.';

CREATE OR REPLACE FUNCTION private.org_settings_customer_agent_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.customer_agent IS NOT NULL THEN
    RAISE EXCEPTION 'org_settings_customer_agent_fence: org_settings.customer_agent (Mia organisation defaults) is written only by the server; role % cannot set it', current_user
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.customer_agent IS DISTINCT FROM OLD.customer_agent THEN
    RAISE EXCEPTION 'org_settings_customer_agent_fence: org_settings.customer_agent (Mia organisation defaults) is written only by the server; role % cannot change it', current_user
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
-- A trigger needs no EXECUTE grant (mig 667 posture: state it closed).
REVOKE EXECUTE ON FUNCTION private.org_settings_customer_agent_fence() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS org_settings_customer_agent_fence ON public.org_settings;
CREATE TRIGGER org_settings_customer_agent_fence
  BEFORE INSERT OR UPDATE ON public.org_settings
  FOR EACH ROW
  EXECUTE FUNCTION private.org_settings_customer_agent_fence();
COMMIT;
