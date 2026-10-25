-- 661 — WACONVCLIENTWRITE.1: no browser or phone session writes
-- public.whatsapp_conversations, public.whatsapp_broadcasts or
-- public.whatsapp_broadcast_recipients.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 29 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-661-whatsapp-conversations-broadcasts-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C66, found planning C55)
-- ===========================================================================
-- All three tables kept Supabase's default table privileges (anon and
-- authenticated: arwdDxtm, from postgres) and client write policies:
--   whatsapp_conversations: wa_conv_insert / wa_conv_update
--     (auth_mobile_can whatsapp) and wa_conv_delete (auth_is_manager_at)
--     beside wa_conv_select (mig 219);
--   whatsapp_broadcasts: whatsapp_broadcasts_location_scoped, FOR ALL,
--     auth_is_in_location (mig 014);
--   whatsapp_broadcast_recipients: whatsapp_broadcast_recipients_via_broadcast,
--     FOR ALL, EXISTS (broadcast at an auth_is_in_location studio) (mig 014).
-- So a WhatsApp-permitted owner/manager/head coach/master could rewrite any
-- conversation at their studio from their own login (the member identity
-- the agent acts for, agent pause, resolved/blocked flags, unread, the 24 h
-- window) and managers could delete a thread with its messages; and ANY
-- staff member at the studio, WhatsApp permission or not, could insert a
-- broadcast with status 'scheduled' that the service-role cron then sends,
-- or rewrite the recipient ledger. auth_is_in_location checks membership,
-- not role or permission.
--
-- VERIFIED LIVE (29 Sep, BEFORE this migration):
--   relacl on all three {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--   authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}; no
--   column ACLs; RLS on, not forced; conversations in supabase_realtime.
--   EXPLAIN of a manager's UPDATE and DELETE on conversations and of a
--   plain staff member's UPDATE on broadcasts all plan (the privilege check
--   passes; the policy is the only filter). Edge logs (four 24 h windows):
--   no client write on any of the three; the only non-service requests were
--   authenticated GETs of conversations (the phone's list and dashboard).
--   The only functions that write them are the two INVOKER counter RPCs,
--   called by the service-role webhook only.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN
--   (PG 17's m) from anon, authenticated, PUBLIC on the three tables.
--   Conversations: drop the three write policies; wa_conv_select unchanged.
--   Broadcasts and recipients: replace each FOR ALL policy with a FOR SELECT
--   TO authenticated policy with the SAME expression (the self-check compares
--   them). SELECT privileges and the supabase_realtime publication are NOT
--   changed: the phone's reads and the web inboxes' realtime need SELECT only.
--   End state per table: anon=r, authenticated=r, one SELECT policy.
--
--   Every writer is service_role: the conversation routes (read/unread,
--   resolve, agent pause/take-over, block, add-contact, sends, start), the
--   Meta webhook (and both counter RPCs), whatsapp.js, the agent, the
--   broadcast routes and cron, contact merge. FK cascades run as the table
--   owner.
--
-- Catalog, policies, triggers, publication and writer functions re-read at
-- build time (29 Sep): unchanged.
--
-- CONSUMERS CHECKED (origin/main d2fa5f78, re-checked at ef4df576; champ-app 828ce00 + its whole
-- history; champ-bridge, un1t-platform, un1t-sentinel, un1t-pi,
-- un1t-finance-agent): no browser, createAuthClient, phone (any bundle since
-- 16 Jul; the April bundle's direct mark-read UPDATE is gone and absent from
-- the logs) or other-repo code writes the three tables. Reads are unchanged.
--
-- Guard: tests/whatsapp-conversations-broadcasts-client-writes-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C66-WACONVCLIENTWRITE.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP/CREATE POLICY take ACCESS EXCLUSIVE on tables the Meta webhook and
-- the broadcast cron write every minute. Abort after 5 s rather than queue
-- inbound messages or a drip tick behind this file. Nothing is
-- half-applied: re-run later.
SET LOCAL lock_timeout = '5s';

-- The read rule each table applies today, as this session renders it, so
-- the self-check can prove the SELECT policies read the same rows. On a
-- re-run the two FOR ALL policies are gone (their rows are absent, so that
-- check is skipped for them); wa_conv_select is compared with itself.
CREATE TEMP TABLE mig661_old_read_rule ON COMMIT DROP AS
  SELECT tablename::text AS tablename, qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (tablename, policyname) IN (
       ('whatsapp_conversations', 'wa_conv_select'),
       ('whatsapp_broadcasts', 'whatsapp_broadcasts_location_scoped'),
       ('whatsapp_broadcast_recipients', 'whatsapp_broadcast_recipients_via_broadcast'));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.whatsapp_conversations, public.whatsapp_broadcasts, public.whatsapp_broadcast_recipients
  FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS wa_conv_insert ON public.whatsapp_conversations;
DROP POLICY IF EXISTS wa_conv_update ON public.whatsapp_conversations;
DROP POLICY IF EXISTS wa_conv_delete ON public.whatsapp_conversations;

DROP POLICY IF EXISTS whatsapp_broadcasts_location_scoped ON public.whatsapp_broadcasts;
DROP POLICY IF EXISTS whatsapp_broadcasts_select ON public.whatsapp_broadcasts;
CREATE POLICY whatsapp_broadcasts_select ON public.whatsapp_broadcasts
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

DROP POLICY IF EXISTS whatsapp_broadcast_recipients_via_broadcast ON public.whatsapp_broadcast_recipients;
DROP POLICY IF EXISTS whatsapp_broadcast_recipients_select ON public.whatsapp_broadcast_recipients;
CREATE POLICY whatsapp_broadcast_recipients_select ON public.whatsapp_broadcast_recipients
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.whatsapp_broadcasts b
                  WHERE b.id = whatsapp_broadcast_recipients.broadcast_id
                    AND private.auth_is_in_location(b.location_id)));

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables  text[] := ARRAY['whatsapp_conversations', 'whatsapp_broadcasts', 'whatsapp_broadcast_recipients'];
  v_selects text[] := ARRAY['wa_conv_select', 'whatsapp_broadcasts_select', 'whatsapp_broadcast_recipients_select'];
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

    -- 1. Anything but SELECT, at table or column level, for the client roles, from any grantor.
    SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
      INTO v_extra
      FROM (
        SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
        UNION ALL
        SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
      ) g;
    IF v_extra IS NOT NULL THEN
      RAISE EXCEPTION 'mig 661: anon/authenticated/PUBLIC still hold write privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The same question asked of the real catalog (role membership, PUBLIC),
    --    one privilege per call. MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 661: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. No column-level write privilege through any path, one privilege per call.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 661: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 4. Reads unchanged (the phone and realtime read through SELECT); the server still reads and writes.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF NOT has_table_privilege(v_role, v_rel, 'SELECT') THEN
        RAISE EXCEPTION 'mig 661: % lost SELECT on %', v_role, v_rel;
      END IF;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 661: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 5. No write policy left; exactly one policy, the expected SELECT one.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
      INTO v_policies
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_tbl
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 661: write policies remain on %: %', v_rel, v_policies;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = v_tbl
                         AND policyname = v_sel AND cmd = 'SELECT'
                         AND permissive = 'PERMISSIVE' AND roles = ARRAY['authenticated']::name[]) THEN
      RAISE EXCEPTION 'mig 661: % should keep exactly one policy, % FOR SELECT', v_rel, v_sel;
    END IF;

    -- 6. That SELECT policy reads exactly what the read rule it replaces read.
    SELECT qual INTO v_old FROM mig661_old_read_rule WHERE tablename = v_tbl;
    IF FOUND AND NOT EXISTS (SELECT 1 FROM pg_policies
                              WHERE schemaname = 'public' AND tablename = v_tbl
                                AND policyname = v_sel AND qual = v_old) THEN
      RAISE EXCEPTION 'mig 661: % does not read the same rows as the policy it replaces', v_sel;
    END IF;
  END LOOP;

  RAISE NOTICE 'mig 661: whatsapp_conversations, whatsapp_broadcasts and whatsapp_broadcast_recipients are read-only for anon/authenticated (one SELECT policy each, same rows); every write is service_role.';
END $$;

COMMIT;
