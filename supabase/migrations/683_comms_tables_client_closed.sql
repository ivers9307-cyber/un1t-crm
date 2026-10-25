-- 683 — MEMBERWRITESWEEP.1d: no browser or phone session reads or writes
-- email_sends, email_templates, sms_broadcasts, sms_broadcast_recipients or
-- agent_message_feedback; anon holds nothing on the five. Every read and
-- write is server code on the service role.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026). Behaviour is
-- proven ahead of apply by tests/migration-683-comms-tables-client-closed.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C101, seen planning C94: its F2)
-- ===========================================================================
-- email_sends, email_templates and agent_message_feedback each carry one FOR
-- ALL policy TO authenticated whose only test is studio membership
-- (private.auth_is_in_location(location_id)); sms_broadcasts carries four
-- (SELECT, INSERT, UPDATE, DELETE) with the same test, and its child
-- sms_broadcast_recipients two (SELECT, INSERT) through its broadcast
-- (EXISTS ... sms_broadcasts b ... auth_is_in_location(b.location_id)). So any
-- plain staff member could, from their own login:
--   * rewrite the HTML of the email templates the booking confirmation,
--     event emails, offer-purchase emails and sequence steps send (the
--     /api/templates routes admit the same people but run a schema the direct
--     path skips);
--   * read 52,304 email sends at Stillorgan (recipient addresses, subjects,
--     open and click data) and edit or delete them;
--   * rate an agent reply as another user (created_by is client-chosen; the
--     /api/agent/feedback route forces it to the caller and checks the
--     message is an agent reply);
--   * read and write the SMS broadcast tables, which no code has used since
--     the SMS retirement (TWILIO-RETIRE.1, migs 664-666).
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration; mig 677 already applied):
-- all five tables still exist (the SMS retirement dropped code, not tables:
-- sms_broadcasts 1 row, sms_broadcast_recipients 6). relacl
-- {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
-- service_role=arwdDxtm/postgres} on all five (no anon), no column ACLs, RLS
-- on (not forced), owner postgres, in no publication, no dependent view,
-- exactly the nine policies above. Triggers ON the five:
-- email_send_activity_trigger (AFTER INSERT on email_sends,
-- public.log_email_send_activity, SECURITY DEFINER, writes activities),
-- email_templates_updated_at (public.update_updated_at, INVOKER) and
-- sms_broadcasts_updated_at (public.sms_broadcasts_set_updated_at, INVOKER).
-- No trigger on any OTHER table has a function that names one of the five,
-- so no trigger writes them as the caller. No policy on another table names
-- any of the five. Functions naming them: campaign_ab_variant_stats,
-- recalculate_campaign_stats (DEFINER), email_sends_monthly_stats,
-- increment_email_send_{clicks,opens}, increment_sms_broadcast_{delivered,
-- metric,undelivered}, org_email_sends_month, rollup_usage_for_day
-- (INVOKER): no client role can EXECUTE any of them (anon and authenticated
-- both false, mig 667). FK actions into the five (campaigns, event_types,
-- event_type_reminders, race_events and sequence_steps reference
-- email_templates) run as the table owner. A real plain staff login at
-- Stillorgan (auth_is_master() false) reads 52,304 email sends, 2 templates,
-- 1 SMS broadcast, 6 SMS recipients and 0 ratings, and EXPLAIN UPDATE
-- public.email_templates plans with only the policy as its filter. Edge logs,
-- 25 Sep 21:40 to 30 Sep 21:40 UTC (five 24 h windows, request.url, so
-- embeds and filters included): every request naming the five is
-- service_role; none from a client, none anon.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE ALL on the five from anon, authenticated and PUBLIC (the writes,
--   the reads, and TRUNCATE, REFERENCES, TRIGGER, MAINTAIN where they are
--   still held). Drop the nine policies. End state: no client privilege, RLS
--   on, no policy (a client read or write is 42501). No comment changes.
--
--   The SMS recipients close with their broadcasts: their policies read
--   sms_broadcasts AS THE CALLER, so revoking sms_broadcasts alone would turn
--   every signed-in read of sms_broadcast_recipients into a 42501 (check 5
--   below refuses to finish while any policy outside this file still names
--   one of the five).
--
--   Writers and readers, all service_role, unchanged: the campaign sender,
--   the sequence runner (src/lib/sequences/steps.js), src/lib/postmark.js,
--   postmark-send-marker, postmark-webhook-processor, the Postmark webhooks
--   (/api/webhooks/postmark, /api/webhooks/qstash/postmark,
--   /api/webhooks/postmark-inbound/[token]), bounce-escalation and its sweep,
--   booking-confirmations, event-email, event-reminders,
--   offer-purchase-emails, email-inbox-send, mail/smtp-send,
--   /api/email/mail/compose and /api/email/mail/[id]/reply and forward,
--   /api/sequences/[id]/stats, /api/templates and /api/templates/[id],
--   /api/events and /api/events/[id], /api/agent/feedback,
--   /api/agent/analytics, src/lib/agent/review.js, contact-merge,
--   contact-export, usage, integration-health, and the server pages
--   (createServerClient): the /communications hub stats, the templates list
--   and editor, list health, a contact's email history. un1t-sentinel reads
--   sms_broadcasts and sms_broadcast_recipients with its service key.
--
-- CONSUMERS CHECKED (un1t-crm 633ac644 incl. mobile/, shared/, desktop/,
-- supabase/functions/postmark-inbound-shim, and history; champ-app
-- origin/main incl. history; un1t-sentinel; champ-bridge; un1t-platform;
-- un1t-pi): no client file reads, writes, embeds or subscribes to any of the
-- five, and no client component imports a src/lib file that does.
--
-- Guard: tests/member-write-sweep-guard.test.js (registry rows, mig 683).
-- APPLY: after this PR merges, per docs/superpowers/plans/2026-09-27-followups/
-- C101-MEMBERWRITESWEEP.1.md, Task 1d-5 (pre/post probes and the rollback).
-- The send crons and webhooks write email_sends every minute: apply when no
-- campaign is queued or sending (counts only); a lock timeout is the worst
-- case, then re-run.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

REVOKE ALL
  ON public.email_sends, public.email_templates, public.sms_broadcasts,
     public.sms_broadcast_recipients, public.agent_message_feedback
  FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS email_sends_location_scoped ON public.email_sends;
DROP POLICY IF EXISTS email_templates_location_scoped ON public.email_templates;
DROP POLICY IF EXISTS sms_broadcast_recipients_insert_at_location ON public.sms_broadcast_recipients;
DROP POLICY IF EXISTS sms_broadcast_recipients_select_at_location ON public.sms_broadcast_recipients;
DROP POLICY IF EXISTS sms_broadcasts_select_at_location ON public.sms_broadcasts;
DROP POLICY IF EXISTS sms_broadcasts_insert_at_location ON public.sms_broadcasts;
DROP POLICY IF EXISTS sms_broadcasts_update_at_location ON public.sms_broadcasts;
DROP POLICY IF EXISTS sms_broadcasts_delete_at_location ON public.sms_broadcasts;
DROP POLICY IF EXISTS agent_feedback_location_scoped ON public.agent_message_feedback;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Every
-- listed table has no client privilege at all, no policy, RLS on and
-- service_role DML; and no policy elsewhere reads one of them as the caller.
-- Any failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['email_sends', 'email_templates', 'sms_broadcasts', 'sms_broadcast_recipients', 'agent_message_feedback'];
  v_tbl text;
  v_rel text;
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    v_rel := 'public.' || v_tbl;

    -- 0. RLS on.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
      RAISE EXCEPTION 'mig 683: row level security is off on %', v_rel;
    END IF;

    -- 1. information_schema, table and column level, any grantor.
    SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
      INTO v_extra
      FROM (
        SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl AND grantee IN ('anon', 'authenticated', 'PUBLIC')
        UNION ALL
        SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      ) g;
    IF v_extra IS NOT NULL THEN
      RAISE EXCEPTION 'mig 683: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The real catalog (role membership, PUBLIC), one privilege per call;
    --    MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 683: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 683: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. The server still reads and writes.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 683: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 4. No policy left.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_policies
      FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 683: % should have no policy left: %', v_rel, v_policies;
    END IF;
  END LOOP;

  -- 5. No policy on another table reads a closed table as the caller (it
  --    would raise 42501 for every signed-in read of that table).
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') INTO v_policies
    FROM pg_policies
   WHERE NOT (schemaname = 'public' AND tablename = ANY (v_tables))
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ ('\m(' || array_to_string(v_tables, '|') || ')\M');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 683: policies on other tables still read a closed table as the caller: %', v_policies;
  END IF;

  RAISE NOTICE 'mig 683: email_sends, email_templates, sms_broadcasts, sms_broadcast_recipients, agent_message_feedback have no client privilege and no policy; every read and write is service_role.';
END $$;

COMMIT;
