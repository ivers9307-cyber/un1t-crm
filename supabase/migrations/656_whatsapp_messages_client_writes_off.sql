-- 656 — WAMSGCLIENTWRITE.1: no browser or phone session writes
-- public.whatsapp_messages.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 29 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-656-whatsapp-messages-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C55, found planning C49)
-- ===========================================================================
-- whatsapp_messages kept Supabase's default table privileges (anon and
-- authenticated: arwdDxtm, granted by postgres) and three permissive write
-- policies:
--   wa_msg_insert  INSERT TO authenticated  CHECK auth_mobile_can(location_id,'whatsapp')
--   wa_msg_update  UPDATE TO authenticated  USING/CHECK the same
--   wa_msg_delete  DELETE TO authenticated  USING auth_is_manager_at(location_id)
-- So any owner, manager, head coach or master holding the WhatsApp
-- permission could, from their own login, insert a message (no contact),
-- rewrite any message's body/direction/status/billable, and (manager and
-- up) delete messages at their studio: the thread history staff read, the
-- agent reads as conversation context, and the spend code counts. It skipped
-- every route, the Meta send and the audit.
--
-- VERIFIED LIVE (29 Sep, BEFORE this migration):
--   relacl {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--   authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}; no
--   column ACLs; RLS on, not forced; in supabase_realtime; one trigger
--   (trg_wa_message_timeline, INVOKER). EXPLAIN of a manager's UPDATE and
--   DELETE plan (privilege check passes; the only filter is the policy).
--   Edge logs (three 24 h windows): every request on /rest/v1/whatsapp_messages
--   was service_role. No function writes the table.
--   Re-read at build time (29 Sep, after migs 648/650/651/653/655 applied):
--   the same relacl, the same four policies, 2,643 rows; 656 not applied.
--   Mig 653 already made contacts read-only for clients, so a client insert
--   WITH a contact_id fails today in the INVOKER timeline trigger (42501 on
--   contacts); one WITHOUT a contact_id still lands. This file closes both.
--   MAINTAIN (Postgres 17's `m`) is left as migs 625/650/653 left it, so
--   relacl ends at anon=rm/postgres, authenticated=rm/postgres.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER from anon,
--   authenticated, PUBLIC; drop the three write policies. SELECT (table
--   privilege and wa_msg_select) and the supabase_realtime publication are
--   NOT changed: the web inboxes' realtime listeners need SELECT only.
--   Every write is service_role (send routes, the Meta webhook, the agent,
--   automations, sequences). A client's whatsapp_conversations delete still
--   cascades here: referential actions run as the table owner.
--
-- CONSUMERS CHECKED (origin/main fa884ca4, re-checked on e44e8ae2; champ-app 828ce00 + its deleted
-- Expo tree; champ-bridge, un1t-platform, un1t-sentinel, un1t-pi): no
-- browser, phone (any bundle since April) or other-repo code writes
-- whatsapp_messages. Reads are unchanged.
--
-- Guard: tests/whatsapp-messages-client-writes-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C55-WAMSGCLIENTWRITE.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on the table the WhatsApp webhook
-- writes. Abort after 5 s rather than queue inbound messages behind this
-- file. Nothing is half-applied: re-run later.
SET LOCAL lock_timeout = '5s';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.whatsapp_messages FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS wa_msg_insert ON public.whatsapp_messages;
DROP POLICY IF EXISTS wa_msg_update ON public.whatsapp_messages;
DROP POLICY IF EXISTS wa_msg_delete ON public.whatsapp_messages;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
  v_maintain text;
BEGIN
  -- 1. Anything but SELECT, at table or column level, for the client roles
  --    (information_schema does not list MAINTAIN; check 2 asks for it).
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (grantor ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'whatsapp_messages'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'whatsapp_messages'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 656: anon/authenticated/PUBLIC still hold write privileges on public.whatsapp_messages: %', v_extra;
  END IF;

  -- 2. The same question asked of the real catalog, which follows role
  --    membership and PUBLIC (information_schema lists role NAMES only).
  --    One privilege per call: a comma list answers "any of them". Every
  --    Postgres 17 table privilege is named: SELECT is checked in 4, the six
  --    writes must be gone, and MAINTAIN (VACUUM/ANALYZE/REINDEX/LOCK, no data
  --    write, no PostgREST path) is left as migs 625/650/653 left it; it is
  --    read here and reported in the closing notice.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.whatsapp_messages', v_priv) THEN
        RAISE EXCEPTION 'mig 656: % still holds % on public.whatsapp_messages', v_role, v_priv;
      END IF;
    END LOOP;
    IF has_table_privilege(v_role, 'public.whatsapp_messages', 'MAINTAIN') THEN
      v_maintain := concat_ws(', ', v_maintain, v_role);
    END IF;
  END LOOP;

  -- 3. No column-level write privilege through any path, one privilege per
  --    call (a comma list would answer "any of them", hiding which one).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(v_role, 'public.whatsapp_messages', v_priv) THEN
        RAISE EXCEPTION 'mig 656: % still holds column-level % on public.whatsapp_messages', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- 4. Reads unchanged (realtime authorises each row through SELECT); the
  --    server path still writes.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT has_table_privilege(v_role, 'public.whatsapp_messages', 'SELECT') THEN
      RAISE EXCEPTION 'mig 656: % lost SELECT on public.whatsapp_messages', v_role;
    END IF;
  END LOOP;
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.whatsapp_messages', v_priv) THEN
      RAISE EXCEPTION 'mig 656: service_role lost % on public.whatsapp_messages', v_priv;
    END IF;
  END LOOP;

  -- 5. No policy may be left that would arm a write if a privilege came back,
  --    and the read policy is the one it was.
  SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
    INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'whatsapp_messages'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 656: write policies remain on public.whatsapp_messages: %', v_policies;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'whatsapp_messages') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'whatsapp_messages'
                     AND policyname = 'wa_msg_select' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE') THEN
    RAISE EXCEPTION 'mig 656: public.whatsapp_messages should keep exactly one policy, wa_msg_select FOR SELECT';
  END IF;

  RAISE NOTICE 'mig 656: public.whatsapp_messages is read-only for anon/authenticated (SELECT + wa_msg_select unchanged; MAINTAIN held by: %); every write is service_role.',
    coalesce(v_maintain, 'none');
END $$;

COMMIT;
