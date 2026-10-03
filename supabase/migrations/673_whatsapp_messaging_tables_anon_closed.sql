-- 673 — WAANONREAD.1: anon holds nothing on public.whatsapp_messages,
-- public.whatsapp_conversations, public.whatsapp_broadcasts or
-- public.whatsapp_broadcast_recipients.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-673-whatsapp-messaging-tables-anon-closed.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C91, found planning C89)
-- ===========================================================================
-- Migs 656 and 661 took every client WRITE off these four tables but kept
-- anon's SELECT (and, on whatsapp_messages, MAINTAIN). No policy on any of
-- them admits anon (each has one SELECT policy TO authenticated), so anon
-- reads an empty set: fenced by RLS, not by the grant. 657 (contacts), 662
-- (consent), 668 (scheduling) and 669 (templates) close anon outright.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration; migs 656 and 661 applied):
--   relacl  whatsapp_messages              {postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=arwdDxtm/postgres}
--           whatsapp_conversations,
--           whatsapp_broadcasts,
--           whatsapp_broadcast_recipients  {postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}
--   no column ACLs; RLS on, not forced; owner postgres.
--   Policies: wa_msg_select, wa_conv_select, whatsapp_broadcasts_select,
--   whatsapp_broadcast_recipients_select, all PERMISSIVE FOR SELECT TO
--   {authenticated}. No policy on any other table names the four; no view
--   depends on them; the four functions that name them (two counter RPCs,
--   rollup_usage_for_day, whatsapp_spend_rollup) are EXECUTE-able by neither
--   anon nor authenticated. supabase_realtime publishes whatsapp_messages and
--   whatsapp_conversations; realtime.subscription held no row at all.
--   Edge logs (two 24 h windows, 28-30 Sep): 0 requests by anon or with no
--   JWT role on /rest/v1/ for any of the four, and none embedding them.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE ALL (all eight PG 17 privileges, MAINTAIN included) on the four
--   tables FROM anon, PUBLIC. Nothing else changes: authenticated keeps
--   exactly what 656/661 left it (whatsapp_messages SELECT + MAINTAIN, the
--   other three SELECT), service_role is untouched, every policy is
--   untouched, the realtime publication is untouched. The self-check
--   captures all of that BEFORE the REVOKE and aborts if any of it moved.
--
-- CONSUMERS CHECKED (origin/main 4aa6df68; champ-app 828ce00 + its whole
-- history; champ-bridge, un1t-platform, un1t-sentinel, un1t-pi,
-- un1t-finance-agent): nothing reads the four tables signed out. Every
-- client reader is signed in (the phone's WhatsApp list and dashboard, the
-- web inbox and broadcast editor realtime); every public route that names
-- them (/api/webhooks/whatsapp, /api/cron/run-whatsapp-broadcasts) is
-- service_role.
--
-- REALTIME EDGE (accepted): after this file, a postgres_changes binding
-- that joins as anon (a browser channel created before its session
-- attaches) gets a 401 payload per change if it is unfiltered; a FILTERED
-- binding fails at join (realtime.subscription_check_filters needs a column
-- privilege anon no longer holds), which errors the whole channel. No
-- current listener on these tables uses a filter (WAInbox, UnifiedInbox:
-- event + schema + table only), and both join signed in.
--
-- Guards: tests/whatsapp-messages-client-writes-guard.test.js and
-- tests/whatsapp-conversations-broadcasts-client-writes-guard.test.js
-- (both extended: no later migration may give anon or PUBLIC anything on
-- these tables).
--
-- APPLY: after this PR merges, same day, after the checks in
-- docs/superpowers/plans/2026-09-27-followups/C91-WAANONREAD.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- REVOKE rewrites pg_class rows of tables the Meta webhook writes every
-- minute. Abort after 5 s rather than wait behind a long lock. Nothing is
-- half-applied: re-run later.
SET LOCAL lock_timeout = '5s';

-- ── 0. 656 and 661 must be live (a re-run passes this block again) ───────
DO $$
DECLARE
  v_tbl  text;
  v_role text;
  v_priv text;
  v_bad  text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['whatsapp_messages', 'whatsapp_conversations', 'whatsapp_broadcasts', 'whatsapp_broadcast_recipients'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(v_role, 'public.' || v_tbl, v_priv) THEN
          RAISE EXCEPTION 'mig 673: apply 656 and 661 first: % still holds % on public.%', v_role, v_priv, v_tbl;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  SELECT string_agg(tablename || '.' || policyname || ' ' || cmd, ', ' ORDER BY tablename, policyname)
    INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('whatsapp_messages', 'whatsapp_conversations', 'whatsapp_broadcasts', 'whatsapp_broadcast_recipients')
     AND cmd <> 'SELECT';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 673: apply 656 and 661 first: write policies remain: %', v_bad;
  END IF;
END $$;

-- ── what must NOT move, read from the catalog before the REVOKE ──────────
-- authenticated's and service_role's privileges (table and column level,
-- one privilege per row), every policy on the four tables (full text), their
-- publication membership and their RLS flags. The self-check re-reads the
-- same view afterwards and compares.
CREATE TEMP VIEW mig673_state AS
  SELECT 'privilege' AS kind, t || ' ' || r || ' ' || p AS item,
         has_table_privilege(r, 'public.' || t, p)::text AS val
    FROM unnest(ARRAY['whatsapp_messages', 'whatsapp_conversations', 'whatsapp_broadcasts', 'whatsapp_broadcast_recipients']) AS t,
         unnest(ARRAY['authenticated', 'service_role']) AS r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p
  UNION ALL
  SELECT 'column privilege', t || ' ' || r || ' ' || p,
         has_any_column_privilege(r, 'public.' || t, p)::text
    FROM unnest(ARRAY['whatsapp_messages', 'whatsapp_conversations', 'whatsapp_broadcasts', 'whatsapp_broadcast_recipients']) AS t,
         unnest(ARRAY['authenticated', 'service_role']) AS r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p
  UNION ALL
  SELECT 'policy', tablename || ' ' || policyname,
         format('%s|%s|%s|%L|%L', permissive, cmd, roles::text, qual, with_check)
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('whatsapp_messages', 'whatsapp_conversations', 'whatsapp_broadcasts', 'whatsapp_broadcast_recipients')
  UNION ALL
  SELECT 'publication', pubname || ' ' || tablename, 'member'
    FROM pg_publication_tables
   WHERE schemaname = 'public'
     AND tablename IN ('whatsapp_messages', 'whatsapp_conversations', 'whatsapp_broadcasts', 'whatsapp_broadcast_recipients')
  UNION ALL
  SELECT 'rls', relname::text, relrowsecurity::text || '/' || relforcerowsecurity::text
    FROM pg_class
   WHERE oid IN ('public.whatsapp_messages'::regclass, 'public.whatsapp_conversations'::regclass,
                 'public.whatsapp_broadcasts'::regclass, 'public.whatsapp_broadcast_recipients'::regclass);

CREATE TEMP TABLE mig673_before ON COMMIT DROP AS SELECT * FROM mig673_state;

-- ── 1. the anon door ─────────────────────────────────────────────────────
REVOKE ALL
  ON public.whatsapp_messages, public.whatsapp_conversations, public.whatsapp_broadcasts, public.whatsapp_broadcast_recipients
  FROM anon, PUBLIC;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['whatsapp_messages', 'whatsapp_conversations', 'whatsapp_broadcasts', 'whatsapp_broadcast_recipients'];
  v_tbl    text;
  v_rel    text;
  v_role   text;
  v_priv   text;
  v_list   text;
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    v_rel := 'public.' || v_tbl;

    -- 1. No anon/PUBLIC entry at table or column level, from any grantor
    --    (information_schema lists role NAMES, so another grantor shows).
    SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
      INTO v_list
      FROM (
        SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl AND grantee IN ('anon', 'PUBLIC')
        UNION ALL
        SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl AND grantee IN ('anon', 'PUBLIC')
      ) g;
    IF v_list IS NOT NULL THEN
      RAISE EXCEPTION 'mig 673: anon/PUBLIC still hold privileges on %: %', v_rel, v_list;
    END IF;

    -- 2. The raw ACLs, table and column (MAINTAIN is not in information_schema).
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                WHERE c.oid = v_rel::regclass AND (a.grantee = 0 OR a.grantee = 'anon'::regrole::oid))
       OR EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                   WHERE att.attrelid = v_rel::regclass AND (a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)) THEN
      RAISE EXCEPTION 'mig 673: the % ACL still names anon or PUBLIC', v_rel;
    END IF;

    -- 3. The real question (follows role membership and PUBLIC), one
    --    privilege per call: a comma list would answer "any of them".
    FOREACH v_role IN ARRAY ARRAY['anon', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 673: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 673: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 4. No policy on the table admits anon or PUBLIC (none did; one now
    --    would be a signed-out reader this file just broke: stop and look).
    SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_list
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_tbl
       AND roles && ARRAY['anon', 'public']::name[];
    IF v_list IS NOT NULL THEN
      RAISE EXCEPTION 'mig 673: policies on % admit anon or PUBLIC: %', v_rel, v_list;
    END IF;
  END LOOP;

  -- 5. Nothing moved but anon's and PUBLIC's rights: authenticated and
  --    service_role privileges, every policy, the publication, RLS.
  SELECT string_agg(kind || ' ' || item || ': ' || coalesce(b.val, '(absent)') || ' -> ' || coalesce(a.val, '(absent)'), '; '
                    ORDER BY kind, item)
    INTO v_list
    FROM mig673_before b
    FULL JOIN mig673_state a USING (kind, item)
   WHERE b.val IS DISTINCT FROM a.val;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 673: something besides anon/PUBLIC changed: %', v_list;
  END IF;

  -- 6. Signed-in reads and the server path are still there (belt and braces
  --    over 5: this is what the inbox, the phone and every route need).
  FOREACH v_tbl IN ARRAY v_tables LOOP
    IF NOT has_table_privilege('authenticated', 'public.' || v_tbl, 'SELECT') THEN
      RAISE EXCEPTION 'mig 673: authenticated lost SELECT on public.%', v_tbl;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', 'public.' || v_tbl, v_priv) THEN
        RAISE EXCEPTION 'mig 673: service_role lost % on public.%', v_priv, v_tbl;
      END IF;
    END LOOP;
  END LOOP;

  -- 7. Nothing an anon session reaches reads the four tables any more: a
  --    policy (on another table) open to anon/PUBLIC whose expression names
  --    them, a view over them anon can select, or a function anon/PUBLIC can
  --    execute whose body names them. Each would now fail (or leak, if
  --    DEFINER) for a signed-out caller.
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ' ORDER BY schemaname, tablename, policyname)
    INTO v_list
    FROM pg_policies
   WHERE roles && ARRAY['anon', 'public']::name[]
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '\m(whatsapp_messages|whatsapp_conversations|whatsapp_broadcasts|whatsapp_broadcast_recipients)\M';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 673: policies open to anon read the WhatsApp tables: %', v_list;
  END IF;
  SELECT string_agg(DISTINCT format('%I.%I', n.nspname, v.relname), ', ')
    INTO v_list
    FROM pg_depend d
    JOIN pg_rewrite rw ON rw.oid = d.objid
    JOIN pg_class v ON v.oid = rw.ev_class
    JOIN pg_namespace n ON n.oid = v.relnamespace
   WHERE d.refobjid = ANY (ARRAY['public.whatsapp_messages'::regclass, 'public.whatsapp_conversations'::regclass,
                                 'public.whatsapp_broadcasts'::regclass, 'public.whatsapp_broadcast_recipients'::regclass]::oid[])
     AND v.oid <> d.refobjid
     AND n.nspname NOT LIKE 'pg_temp%'
     AND (has_table_privilege('anon', v.oid, 'SELECT') OR has_table_privilege('public', v.oid, 'SELECT'));
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 673: views anon can read depend on the WhatsApp tables: %', v_list;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_list
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prosrc ~ '\m(whatsapp_messages|whatsapp_conversations|whatsapp_broadcasts|whatsapp_broadcast_recipients)\M'
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('public', p.oid, 'EXECUTE'));
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 673: functions anon can execute name the WhatsApp tables: %', v_list;
  END IF;

  RAISE NOTICE 'mig 673: anon and PUBLIC hold nothing on whatsapp_messages, whatsapp_conversations, whatsapp_broadcasts and whatsapp_broadcast_recipients; authenticated, service_role, every policy and the realtime publication unchanged.';
END $$;

DROP VIEW mig673_state;

COMMIT;
