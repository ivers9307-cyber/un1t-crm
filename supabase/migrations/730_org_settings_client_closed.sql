-- 730 — ORGSETCLIENTWRITE.1: no browser or phone session reads or writes
-- public.org_settings; anon holds nothing on it. Every read and write is
-- server code on the service role.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 17 Oct 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-730-org-settings-client-closed.test.js).
--
-- ===========================================================================
-- THE FINDING (the MEMBERWRITESWEEP / CARSCLIENTWRITE class, CLAUDE.md)
-- ===========================================================================
-- org_settings (mig 317; columns from migs 414/416/421/424/425/715/729) kept
-- table-level INSERT/UPDATE/DELETE for authenticated, and its write policies
-- (mig 320, active-staff gate from 626):
--   org_settings_ins / org_settings_upd / org_settings_del:
--     private.auth_is_master() OR EXISTS (locations l JOIN profile_locations
--     pl ... l.organization_id = org_settings.organization_id AND
--     pl.profile_id = auth.uid() AND pl.role = 'owner' AND active staff)
-- admit an OWNER AT ANY ONE STUDIO of the organisation. The routes are
-- tighter: /api/settings/org-branding and /api/settings/org-usage resolve the
-- org with resolveAdminOrgId (masters and organisation admins only) and
-- validate the body; /api/settings/customer-agent/org (MIAORG.1) does the
-- same. The table has no audit trigger (only touch_updated_at), so a client
-- write left no trace beyond updated_at. So, from their own login with
-- createBrowserClient(), a studio owner could rewrite for the WHOLE org:
--   * ai_hard_cap_cents / email_hard_cap_sends (the cost ceilings; clearing
--     them lifts the cap, ai/email_cap_notice_month silences its notice);
--   * legal_entity_name, legal_trading_name, legal_address,
--     privacy_contact_email (mig 425: the hosted privacy notice and every
--     contract's contracting entity);
--   * ops_alert_emails (mig 424: where ops alerts go);
--   * logo_url, favicon_url, company_name, short_name (the brand on every
--     email, page and product name of every studio in the org);
--   * create the row for an org that has none, or delete it outright;
-- all past the admin check, the route's validation, and with no audit row.
-- (Mig 729's BEFORE trigger already refused a client change to
-- customer_agent; it said the rest was out of its scope. This is the rest.)
--
-- VERIFIED LIVE (17 Oct 2026, BEFORE this migration; migs 677 and 729
-- applied): relacl {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
-- service_role=arwdDxtm/postgres} (no anon, no PUBLIC); column privileges
-- are only the table grant's expansion (17 columns x SELECT/INSERT/UPDATE
-- for authenticated); RLS on, not forced; owner postgres; in no publication
-- (no realtime); no dependent view; no policy on any OTHER table names
-- org_settings; the only function naming it is
-- private.org_settings_customer_agent_fence (mig 729, INVOKER, no client
-- EXECUTE). Exactly four policies: org_settings_select (SELECT: the owner
-- test OR private.auth_is_in_organization(organization_id)) and the three
-- write policies above, all TO authenticated. Triggers (both BEFORE, both
-- INVOKER, both kept): org_settings_touch_updated_at (UPDATE) and
-- org_settings_customer_agent_fence (INSERT OR UPDATE, mig 729). FKs out:
-- organizations ON DELETE CASCADE, profiles (updated_by); none in. 2 rows.
-- Edge logs, 15 Oct 08:31 to 17 Oct 08:31 UTC, every request whose URL names
-- org_settings (so embeds included): 5,053, every one GET by service_role;
-- never authenticated, never anon, never a write.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE ALL on public.org_settings from anon, authenticated and PUBLIC.
--   The task allowed keeping SELECT and its one policy if a client reads the
--   table; none does (below), so the reads close too, as company_settings
--   did in mig 674. Drop all four policies. RLS stays on with no policy. End
--   state: service_role only; a client read or write is 42501.
--   Both triggers are untouched; the self-check refuses to finish if 729's
--   fence is gone while its column exists (it stays as a second fence for
--   the day a grant comes back).
--   customer_agent's column comment (mig 729) said every org member could
--   read it through org_settings_select; that is no longer true, so its last
--   sentence is restated here when the column exists (729 is applied on prod
--   but not yet merged when this was written; the guard keeps 730 runnable
--   either way).
--
-- WRITERS AND READERS, all service_role (createServerClient), unchanged:
--   writes: /api/settings/org-branding (PUT upsert), /api/settings/org-usage
--   (PUT upsert), /api/cron/usage-rollup (cap notice month),
--   /api/settings/customer-agent/org (MIAORG.1).
--   reads: /api/public/branding, /api/contracts, src/lib/location-branding,
--   host-brand, host-org-brand, contracting-entity, tenant-privacy,
--   ops-alerts, usage-caps, usage-summary, agent/settings-resolve and the
--   server layouts and pages that call them (every caller passes
--   createServerClient()). The only browser surface, OrgBrandingSettings,
--   goes through /api/settings/org-branding with fetch.
--
-- CONSUMERS CHECKED (un1t-crm origin/main 1ad11246 and feat/mia-org-settings
-- 055c9b75, incl. mobile/, shared/, desktop/ and supabase/functions;
-- champ-app; champ-bridge; un1t-pi; un1t-sentinel): no browser, phone,
-- desktop or other-repo file reads, writes, embeds or subscribes to
-- org_settings with a client session. The phone reads the brand through
-- /api/public/branding (mobile/lib/brand.js). Only two client session
-- factories exist (src/lib/supabase.js): the browser client, and the server
-- client, which is service_role; there is no user-session server client.
--
-- Guard: tests/org-settings-client-closed-guard.test.js.
--
-- APPLY: no code changes with this file (no client used the grants), so it
-- applies ahead of the merge, per CLAUDE.md. Rollback: the test's
-- ROLLBACK_730 (the grant and the four policies, verbatim from mig 320/626).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on a table every branded email, page and
-- the usage-cap check read. Abort after 5 s rather than queue behind them.
-- Nothing is half-applied: re-run.
SET LOCAL lock_timeout = '5s';

REVOKE ALL ON public.org_settings FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS org_settings_select ON public.org_settings;
DROP POLICY IF EXISTS org_settings_ins ON public.org_settings;
DROP POLICY IF EXISTS org_settings_upd ON public.org_settings;
DROP POLICY IF EXISTS org_settings_del ON public.org_settings;

COMMENT ON TABLE public.org_settings IS
  'Organisation-wide branding, legal identity, ops alert recipients, usage caps and Mia defaults (mig 317+). Service role only (ORGSETCLIENTWRITE.1, mig 730): no client privilege, RLS on with no policy. Written through /api/settings/org-branding, /api/settings/org-usage and /api/settings/customer-agent/org (masters and organisation admins, resolveAdminOrgId) and the usage-rollup cron.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.org_settings'::regclass
                AND attname = 'customer_agent' AND NOT attisdropped) THEN
    EXECUTE $c$COMMENT ON COLUMN public.org_settings.customer_agent IS
      'MIAORG.1 (mig 729): organisation-level Mia defaults, same shape as locations.settings.customer_agent; studio-only keys are never read from here. NULL = none set. Copy and tuning only, no secrets. No client session reads or writes it since mig 730 (the table is service_role only); org_settings_customer_agent_fence refuses a client write as a second fence.'$c$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rel constant text := 'public.org_settings';
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
BEGIN
  -- 0. RLS still on: with no policy it is the second fence behind the grant.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
    RAISE EXCEPTION 'mig 730: row level security is off on %', v_rel;
  END IF;

  -- 1. anon, authenticated, PUBLIC: nothing, table and column level, any grantor.
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'org_settings'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'org_settings'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 730: client roles still hold privileges on %: %', v_rel, v_extra;
  END IF;

  -- 2. The same question asked of the real catalog (role membership,
  --    PUBLIC), one privilege per call. MAINTAIN is not in information_schema.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege(v_role, v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 730: % still holds % on %', v_role, v_priv, v_rel;
      END IF;
    END LOOP;
    -- 3. No column-level privilege through any path.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 730: % still holds column-level % on %', v_role, v_priv, v_rel;
      END IF;
    END LOOP;
  END LOOP;

  -- 4. The server still reads and writes.
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
      RAISE EXCEPTION 'mig 730: service_role lost % on %', v_priv, v_rel;
    END IF;
  END LOOP;

  -- 5. No policy at all (a permissive one would be dead today, and the
  --    first to re-grant a privilege would bring it back to life).
  SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
    INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_settings';
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 730: % should have no policy left: %', v_rel, v_policies;
  END IF;

  -- 6. The triggers this file leaves alone are still there: updated_at, and
  --    mig 729's customer_agent fence wherever its column exists.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_rel::regclass
                  AND tgname = 'org_settings_touch_updated_at' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'mig 730: org_settings_touch_updated_at is missing on %', v_rel;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = v_rel::regclass
              AND attname = 'customer_agent' AND NOT attisdropped)
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_rel::regclass
                      AND tgname = 'org_settings_customer_agent_fence' AND NOT tgisinternal
                      AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'mig 730: customer_agent exists but org_settings_customer_agent_fence (mig 729) is missing or disabled on %', v_rel;
  END IF;

  RAISE NOTICE 'mig 730: org_settings is service_role only (no client privilege, RLS on, no policy; triggers kept).';
END $$;

COMMIT;
