-- 669 — WATPLCLIENTWRITE.1: no browser or phone session writes
-- public.whatsapp_templates or public.whatsapp_template_events, and anon
-- holds nothing on either.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-669-whatsapp-templates-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C89, found reviewing C79 WATPLROLE.1)
-- ===========================================================================
-- Both tables kept Supabase's default table privileges (anon and
-- authenticated: arwdDxtm, from postgres) and client write policies:
--   whatsapp_templates: wa_tmpl_insert / wa_tmpl_update
--     (auth_mobile_can whatsapp) and wa_tmpl_delete (auth_is_manager_at)
--     beside wa_tmpl_select (mig 219);
--   whatsapp_template_events: whatsapp_template_events_via_template, FOR ALL,
--     EXISTS (a template the caller can see at an auth_is_in_location
--     studio) (mig 254).
-- So a WhatsApp-permitted session could, from its own login and past every
-- route gate (C79 makes create/delete/content edits manager-only):
--   UPDATE header_media_url or components of an APPROVED template (the send
--   paths read header_media_url at send time and pass it to Meta as the
--   header link, so customers receive that media, no Meta review);
--   INSERT a local row with status 'APPROVED';
--   DELETE a template (managers; its events cascade);
--   write the template's audit trail (forge a status event).
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   relacl on both {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--   authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}; no
--   column ACLs; RLS on, not forced; both in supabase_realtime. EXPLAIN of a
--   head coach's UPDATE of header_media_url plans (the privilege check
--   passes; the policy is the only filter). Edge logs (two 24 h windows):
--   no client request of any kind on either table or on the template RPC.
--   The only function that writes whatsapp_templates is
--   increment_whatsapp_template_sent (INVOKER; EXECUTE postgres and
--   service_role only since mig 667). No trigger elsewhere writes them.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN
--   (PG 17's m) from anon, authenticated, PUBLIC on both tables, and the
--   remaining SELECT from anon and PUBLIC (no anon policy exists, so anon
--   only ever read an empty set; nothing reads them signed out).
--   whatsapp_templates: drop the three write policies; wa_tmpl_select is
--   not touched (the phone's template picker and the web list's realtime).
--   whatsapp_template_events: replace the FOR ALL policy with a FOR SELECT
--   TO authenticated policy with the SAME expression (the self-check
--   compares them). The supabase_realtime publication is not changed.
--   End state per table: anon nothing, authenticated=r, one SELECT policy.
--
--   Every writer is service_role: the template routes (sync, create, PUT,
--   resubmit, DELETE, upload-media), the Meta webhook (status/quality/
--   category events), the broadcast sender (increment_whatsapp_template_sent).
--   FK actions (events cascade, SET NULL on sequence_steps, locations,
--   event_types) run as the table owner.
--
-- CONSUMERS CHECKED (origin/main 2e3bb50f, re-checked on e258652d after C79
-- merged; champ-app 828ce00 + its history, re-checked on its origin/main;
-- champ-bridge, un1t-platform, un1t-sentinel, un1t-pi, un1t-finance-agent):
-- no browser, createAuthClient, phone (any bundle since 30 Apr) or
-- other-repo code writes either table. Client reads, unchanged: the phone's
-- listTemplates and the web template list's realtime subscription.
--
-- Guard: tests/whatsapp-templates-client-writes-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C89-WATPLCLIENTWRITE.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP/CREATE POLICY take ACCESS EXCLUSIVE on tables the Meta webhook and
-- the broadcast sender write. Abort after 5 s rather than queue a webhook
-- behind this file. Nothing is half-applied: re-run later.
SET LOCAL lock_timeout = '5s';

-- The read rule each table applies today, as this session renders it, so
-- the self-check can prove the SELECT policies read the same rows. On a
-- re-run the events FOR ALL policy is gone (its row is absent, so that
-- check is skipped for it); wa_tmpl_select is compared with itself.
CREATE TEMP TABLE mig669_old_read_rule ON COMMIT DROP AS
  SELECT tablename::text AS tablename, qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (tablename, policyname) IN (
       ('whatsapp_templates', 'wa_tmpl_select'),
       ('whatsapp_template_events', 'whatsapp_template_events_via_template'));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.whatsapp_templates, public.whatsapp_template_events
  FROM anon, authenticated, PUBLIC;
REVOKE ALL
  ON public.whatsapp_templates, public.whatsapp_template_events
  FROM anon, PUBLIC;

DROP POLICY IF EXISTS wa_tmpl_insert ON public.whatsapp_templates;
DROP POLICY IF EXISTS wa_tmpl_update ON public.whatsapp_templates;
DROP POLICY IF EXISTS wa_tmpl_delete ON public.whatsapp_templates;

DROP POLICY IF EXISTS whatsapp_template_events_via_template ON public.whatsapp_template_events;
DROP POLICY IF EXISTS whatsapp_template_events_select ON public.whatsapp_template_events;
CREATE POLICY whatsapp_template_events_select ON public.whatsapp_template_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.whatsapp_templates t
                  WHERE t.id = whatsapp_template_events.template_id
                    AND private.auth_is_in_location(t.location_id)));

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables  text[] := ARRAY['whatsapp_templates', 'whatsapp_template_events'];
  v_selects text[] := ARRAY['wa_tmpl_select', 'whatsapp_template_events_select'];
  v_tbl text;
  v_sel text;
  v_rel text;
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
  v_old text;
BEGIN
  FOR i IN 1 .. array_length(v_tables, 1) LOOP
    v_tbl := v_tables[i];
    v_sel := v_selects[i];
    v_rel := 'public.' || v_tbl;

    -- 1. anon/PUBLIC: nothing at all; authenticated: nothing but SELECT.
    --    Table and column level, any grantor.
    SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
      INTO v_extra
      FROM (
        SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND (grantee IN ('anon', 'PUBLIC') OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'))
        UNION ALL
        SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND (grantee IN ('anon', 'PUBLIC') OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'))
      ) g;
    IF v_extra IS NOT NULL THEN
      RAISE EXCEPTION 'mig 669: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The same question asked of the real catalog (role membership,
    --    PUBLIC), one privilege per call. MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF (v_role <> 'authenticated' OR v_priv <> 'SELECT') AND has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 669: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. No column-level privilege through any path (authenticated: writes
    --    only; its table-level SELECT covers every column), one per call.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF (v_role <> 'authenticated' OR v_priv <> 'SELECT') AND has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 669: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 4. Signed-in reads unchanged (the phone and realtime read through
    --    SELECT); the server still reads and writes.
    IF NOT has_table_privilege('authenticated', v_rel, 'SELECT') THEN
      RAISE EXCEPTION 'mig 669: authenticated lost SELECT on %', v_rel;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 669: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 5. No write policy left; exactly one policy, the expected SELECT one.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
      INTO v_policies
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_tbl
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 669: write policies remain on %: %', v_rel, v_policies;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = v_tbl
                         AND policyname = v_sel AND cmd = 'SELECT'
                         AND permissive = 'PERMISSIVE' AND roles = ARRAY['authenticated']::name[]) THEN
      RAISE EXCEPTION 'mig 669: % should keep exactly one policy, % FOR SELECT', v_rel, v_sel;
    END IF;

    -- 6. That SELECT policy reads exactly what the read rule it replaces read.
    SELECT qual INTO v_old FROM mig669_old_read_rule WHERE tablename = v_tbl;
    IF FOUND AND NOT EXISTS (SELECT 1 FROM pg_policies
                              WHERE schemaname = 'public' AND tablename = v_tbl
                                AND policyname = v_sel AND qual = v_old) THEN
      RAISE EXCEPTION 'mig 669: % does not read the same rows as the policy it replaces', v_sel;
    END IF;
  END LOOP;

  RAISE NOTICE 'mig 669: whatsapp_templates and whatsapp_template_events are read-only for authenticated (one SELECT policy each, same rows) and closed to anon; every write is service_role.';
END $$;

COMMIT;
