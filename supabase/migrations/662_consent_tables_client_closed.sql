-- 662 — CONSENTREAD.1: no browser or phone session reads consent
-- (public.contact_preferences, public.contact_location_preferences,
-- public.consent_log, and the view public.contact_location_audience).
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 29 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-662-consent-tables-client-closed.test.js), which applies
-- the real mig 660 first.
--
-- ORDER: APPLY ONLY AFTER MIG 660 (CONSENTCLIENTWRITE.1). 660's self-check
-- requires client SELECT and one <table>_select policy per table; this file
-- removes both, so 662-before-660 would make 660 abort forever. The first
-- block below refuses to run while the pre-660 state (client write
-- privileges or write policies) is live.
--
-- ===========================================================================
-- THE FINDING (follow-ups C68, found planning C64)
-- ===========================================================================
-- After 660 the three tables are read-only for clients, but every one still
-- has a SELECT policy TO authenticated keyed on auth_is_in_location (studio
-- membership, not role), and the view kept Supabase's default grants. So any
-- active staff member could read, from their own login: every customer's
-- unsubscribe token at their studio (the only credential behind
-- /preferences/[token], /unsubscribe/[token] and the HR-email preference
-- link, so a staff member could change a customer's consent through the
-- public page and it would be logged as the customer), customers' consent
-- IP addresses and user agents, the full consent history and the
-- per-studio consent rows (directly and through the view).
--
-- VERIFIED LIVE (29 Sep, counts only; before 660 the same rows were readable
-- through the FOR ALL policies 660 replaces with same-expression SELECT
-- policies): a plain Stillorgan staff session read 8,553 tokens, 4,803
-- consent IPs (user_agent is NULL on every row today), 15,549 consent_log
-- rows, 8,688 contact_location_preferences rows and 8,687 view rows.
-- Members have no profiles row, so no policy ever admitted them. Edge logs
-- (four 24 h windows): every request on the three tables and the view was
-- service_role; no client request embedded them.
-- Mig 660 was applied on prod on 29 Sep (~13:33 UTC). Re-measured after it
-- (read-only, counts only): each table anon=r, authenticated=r, exactly one
-- <table>_select policy; a Stillorgan staff login read 8,555
-- contact_preferences, 8,690 contact_location_preferences and 15,551
-- consent_log rows; edge logs (24 h) on the three tables: all service_role.
--
-- ===========================================================================
-- THE FIX (the mig 655 audit_events shape)
-- ===========================================================================
--   Drop the three SELECT policies 660 created; REVOKE ALL (PG 17: all eight
--   privileges, MAINTAIN included) on the three tables and the view from
--   anon, authenticated, PUBLIC. RLS stays enabled with no policy, so a
--   client that regained a privilege would still read 0 rows. service_role
--   is untouched; the DEFINER mirror/create triggers run as postgres; the
--   INVOKER auto_unsubscribe_classpass runs as the contacts writer, which is
--   service_role since mig 653. Table comments are kept.
--
-- CONSUMERS CHECKED (origin/main d2fa5f78; champ-app 828ce00 + its whole
-- history; champ-bridge, un1t-platform, un1t-sentinel, un1t-pi,
-- un1t-finance-agent): no browser, createAuthClient, phone (any bundle) or
-- other-repo code reads the three tables or the view, directly or embedded
-- in another table's select (mobile/, shared/ and the createAuthClient files
-- re-checked on origin/main 2ae641c7). Every reader is service_role: the consent
-- routes, the campaign/sequence/SMS/WhatsApp senders, the audience count,
-- list health, the consent-drift cron.
--
-- The view: mig 652 (C50) and any later re-creation must restore its ACL
-- from the catalog (C50 plan D3), which preserves "no client privilege".
--
-- Guard: tests/consent-tables-client-closed-guard.test.js.
--
-- APPLY: after this PR merges AND after mig 660 is applied, same day, after
-- the log check in docs/superpowers/plans/2026-09-27-followups/C68-CONSENTREAD.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on tables the campaign sender, the
-- unsubscribe routes and contact creation touch. Abort after 5 s rather
-- than queue a send or an unsubscribe behind this file. Nothing is
-- half-applied: re-run later. Same table order as 660 and the triggers.
SET LOCAL lock_timeout = '5s';

-- ── 0. 660 must be live (and this block passes again on a re-run) ──────
DO $$
DECLARE
  v_bad  text;
  v_tbl  text;
  v_role text;
  v_priv text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname || ' ' || cmd, ', ' ORDER BY tablename, policyname)
    INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('contact_preferences', 'contact_location_preferences', 'consent_log')
     AND cmd <> 'SELECT';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 662: apply 660 (CONSENTCLIENTWRITE.1) first: write policies remain: %', v_bad;
  END IF;
  FOREACH v_tbl IN ARRAY ARRAY['contact_preferences', 'contact_location_preferences', 'consent_log'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(v_role, 'public.' || v_tbl, v_priv) THEN
          RAISE EXCEPTION 'mig 662: apply 660 (CONSENTCLIENTWRITE.1) first: % still holds % on public.%', v_role, v_priv, v_tbl;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- ── 1. the client door ──────────────────────────────────────────────────
DROP POLICY IF EXISTS contact_preferences_select ON public.contact_preferences;
DROP POLICY IF EXISTS contact_location_preferences_select ON public.contact_location_preferences;
DROP POLICY IF EXISTS consent_log_select ON public.consent_log;

REVOKE ALL ON public.contact_preferences, public.contact_location_preferences, public.consent_log
  FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rels   text[] := ARRAY['public.contact_preferences', 'public.contact_location_preferences',
                           'public.consent_log', 'public.contact_location_audience'];
  v_rel    text;
  v_role   text;
  v_priv   text;
  v_list   text;
BEGIN
  FOREACH v_rel IN ARRAY v_rels LOOP
    IF v_rel <> 'public.contact_location_audience' THEN
      -- 1. no policy of any kind left (a stray one means someone reads it from a client: stop and look)
      SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_list
        FROM pg_policies WHERE schemaname = 'public' AND tablename = split_part(v_rel, '.', 2);
      IF v_list IS NOT NULL THEN
        RAISE EXCEPTION 'mig 662: % still has a policy: %', v_rel, v_list;
      END IF;

      -- 2. RLS still enabled
      IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
        RAISE EXCEPTION 'mig 662: RLS is not enabled on %', v_rel;
      END IF;

      -- 4a. the service role still reads and writes
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 662: service_role lost % on %', v_priv, v_rel;
        END IF;
      END LOOP;
    END IF;

    -- 3. no client privilege, table or column, inheritance-aware, any grantor:
    --    one call per (role, privilege). MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 662: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 662: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 4b. the service role still reads the view (the senders, audience count, list health, drift cron)
  IF NOT has_table_privilege('service_role', 'public.contact_location_audience', 'SELECT') THEN
    RAISE EXCEPTION 'mig 662: service_role lost SELECT on public.contact_location_audience';
  END IF;

  -- 5. the view still runs as the caller (a DEFINER view would bypass every RLS it reads)
  IF NOT EXISTS (SELECT 1 FROM pg_class c, unnest(coalesce(c.reloptions, '{}'::text[])) o
                  WHERE c.oid = 'public.contact_location_audience'::regclass
                    AND lower(o) IN ('security_invoker=on', 'security_invoker=true', 'security_invoker=1', 'security_invoker=yes')) THEN
    RAISE EXCEPTION 'mig 662: public.contact_location_audience is no longer security_invoker';
  END IF;

  -- 6. no policy on another table reads the consent tables: for a client it would now fail
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ' ORDER BY schemaname, tablename, policyname) INTO v_list
    FROM pg_policies
   WHERE tablename NOT IN ('contact_preferences', 'contact_location_preferences', 'consent_log')
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '\m(contact_preferences|contact_location_preferences|consent_log)\M';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 662: policies on other tables read the consent tables (a client read would now fail): %', v_list;
  END IF;

  -- 7. no other view over them (it would need the same closing, or would expose them if DEFINER)
  SELECT string_agg(DISTINCT format('%I.%I', n.nspname, v.relname), ', ') INTO v_list
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class v ON v.oid = r.ev_class
    JOIN pg_namespace n ON n.oid = v.relnamespace
   WHERE d.refobjid IN ('public.contact_preferences'::regclass, 'public.contact_location_preferences'::regclass,
                        'public.consent_log'::regclass)
     AND v.oid <> d.refobjid
     AND v.oid <> 'public.contact_location_audience'::regclass;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'mig 662: views other than contact_location_audience depend on the consent tables: %', v_list;
  END IF;

  RAISE NOTICE 'mig 662: contact_preferences, contact_location_preferences, consent_log and contact_location_audience are closed to anon/authenticated (no privilege, no policy, RLS on); every reader is service_role.';
END $$;

COMMIT;
