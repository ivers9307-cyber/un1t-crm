-- 684 — MEMBERWRITESWEEP.1e: no browser or phone session reads or writes
-- campaigns or campaign_recipients; anon holds nothing on the two. Every read
-- and write is server code on the service role.
--
-- APPLY ONLY AFTER this PR's code has been live on production for at least
-- 1 h (plan Task 1e-7): merge, confirm the Vercel production deploy for the
-- merge commit is READY, then the edge logs must show 0 non-service_role
-- /rest/v1/campaigns requests for at least 1 h, then apply. A browser tab
-- opened before the deploy still runs the old bundle and writes campaigns
-- directly; after this file its saves fail with a permission error, so
-- operators hard-reload any open Communications tab first.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 1 Oct 2026). Behaviour is
-- proven ahead of apply by tests/migration-684-campaigns-client-closed.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C101, seen planning C94: its F2)
-- ===========================================================================
-- campaigns carries one FOR ALL policy TO authenticated whose only test is
-- studio membership (private.auth_is_in_location(location_id)), and its child
-- campaign_recipients one FOR ALL policy through its campaign
-- (EXISTS ... campaigns ca ... auth_is_in_location(ca.location_id)). The web
-- Campaign editor and the campaign detail page wrote campaigns straight from
-- the browser client (no session route existed; /api/campaigns is Bearer-only
-- for n8n), so the policy was the only fence, and it admits every member of
-- the studio. Any plain staff member (and reception), with or without the
-- `email` permission the Communications pages and the send route require,
-- could from their own login:
--   * create, rewrite, schedule, stop or delete a marketing campaign
--     (scheduling is a send: the 5-minute run-campaigns cron promotes a
--     'scheduled' campaign and mails its audience), past the audience-filter
--     validation, the send route's subject/body guard and its status rule;
--   * choose created_by on a create and rewrite it on every save;
--   * read and rewrite every recipient row (29,142 at Stillorgan: contact,
--     delivery, open and click state) and delete a draft with its recipients.
--
-- VERIFIED LIVE (1 Oct 2026, BEFORE this migration; mig 677 already applied):
-- relacl {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
-- service_role=arwdDxtm/postgres} on both (no anon), no column ACLs, RLS on
-- (not forced), owner postgres, in no publication (no realtime), no dependent
-- view, exactly the two policies above. Triggers ON campaigns:
-- campaigns_block_sent_delete (BEFORE DELETE), campaigns_lock_sent_content
-- (BEFORE UPDATE) and campaigns_updated_at (BEFORE UPDATE,
-- public.update_updated_at), all SECURITY INVOKER; none on
-- campaign_recipients. No trigger on any OTHER table has a function that
-- names either table. No policy on another table names either table.
-- Functions naming them: campaign_ab_variant_stats,
-- increment_campaign_metric, recalculate_campaign_stats (DEFINER),
-- campaign_outcome_stats, campaign_recipient_stats,
-- campaigns_block_sent_delete, email_bounce_type_summary,
-- list_health_monthly_stats (INVOKER): no client role can EXECUTE any of
-- them (anon and authenticated both false). FKs INTO campaigns:
-- campaign_recipients and campaign_link_clicks (ON DELETE CASCADE),
-- email_sends, unsubscribe_refusals and campaigns.parent_campaign_id (SET
-- NULL); FK actions run as the table owner. campaign_link_clicks and
-- unsubscribe_refusals stay readable by clients as before: their own
-- policies never read campaigns, but an EMBED of campaigns(...) in a client
-- select on them would now fail 42501 (none exists: the sweep guard checks
-- every client file). 27 campaigns (4 draft, 23 sent), 29,504 recipients,
-- 0 with a NULL location_id. A real plain staff login at Stillorgan
-- (auth_is_master() false) reads 21 campaigns and 29,142 recipients, and
-- EXPLAIN UPDATE public.campaigns SET status = 'scheduled' plans with only
-- the policy as its filter. Edge logs (request.url, so embeds and filters
-- included), 29 Sep 23:00 to 30 Sep 23:36 UTC: no client request; 28 Sep
-- 23:00 to 29 Sep 23:00: the web editor's PATCH x4, GET x1 and OPTIONS x2 on
-- /rest/v1/campaigns (authenticated, one Mac browser session, 20:45-20:47
-- UTC); never campaign_recipients, never anon.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   Code first, in the same PR: the six browser reads and writes moved to
--   session routes that check `email` at the campaign's studio (the page's
--   own gate, D7) and set created_by from the session:
--   POST /api/communications/campaigns (create), GET, PUT, DELETE
--   /api/communications/campaigns/[id] (the 3 s progress poll, save,
--   delete), POST /api/communications/campaigns/[id]/schedule and
--   POST /api/communications/campaigns/[id]/stop.
--
--   Then this file: REVOKE ALL on the two from anon, authenticated and
--   PUBLIC (the writes, the reads, and TRUNCATE, REFERENCES, TRIGGER,
--   MAINTAIN where they are still held). Drop the two policies. End state:
--   no client privilege, RLS on, no policy (a client read or write is 42501).
--   No comment changes; the triggers are untouched.
--
--   The recipients close with their campaigns: their policy reads campaigns
--   AS THE CALLER, so revoking campaigns alone would turn every signed-in
--   read of campaign_recipients into a 42501 (check 5 below refuses to
--   finish while any policy outside this file still names one of the two).
--
--   Writers and readers, all service_role, unchanged: the session routes
--   above, /api/campaigns and /api/campaigns/[id] (n8n, Bearer), and the
--   /api/campaigns/[id] send, send-test, duplicate, preview, resend, links
--   and outcomes routes, /api/communications/email-draft (the composer),
--   /api/cron/run-campaigns and src/lib/campaign-sender.js,
--   campaign-resend, postmark-webhook-processor, bounce-escalation-sweep,
--   tenant-health, contact-merge (re-points campaign_recipients.contact_id),
--   /view-email/[token], and the Communications server pages (the sent list
--   and the detail page). No other repo names either table.
--
-- CONSUMERS CHECKED (un1t-crm incl. mobile/, shared/, desktop/ and
-- supabase/functions; champ-app; un1t-sentinel; champ-bridge; un1t-platform;
-- un1t-pi): after this PR no client file reads, writes, embeds or subscribes
-- to either table, and no client component imports a src/lib file that does.
--
-- Guard: tests/member-write-sweep-guard.test.js (registry rows, mig 684).
-- APPLY: per docs/superpowers/plans/2026-09-27-followups/
-- C101-MEMBERWRITESWEEP.1.md, Task 1e-7 (the wait, the log check, pre/post
-- probes and the rollback). The run-campaigns cron writes campaigns and
-- campaign_recipients every minute while a campaign sends: apply when no
-- campaign is queued or sending (counts only); a lock timeout is the worst
-- case, then re-run.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

REVOKE ALL
  ON public.campaigns, public.campaign_recipients
  FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS campaign_recipients_via_campaign ON public.campaign_recipients;
DROP POLICY IF EXISTS campaigns_location_scoped ON public.campaigns;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Every
-- listed table has no client privilege at all, no policy, RLS on and
-- service_role DML; and no policy elsewhere reads one of them as the caller.
-- Any failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['campaigns', 'campaign_recipients'];
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
      RAISE EXCEPTION 'mig 684: row level security is off on %', v_rel;
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
      RAISE EXCEPTION 'mig 684: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The real catalog (role membership, PUBLIC), one privilege per call;
    --    MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 684: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 684: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. The server still reads and writes.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 684: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 4. No policy left.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_policies
      FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 684: % should have no policy left: %', v_rel, v_policies;
    END IF;
  END LOOP;

  -- 5. No policy on another table reads a closed table as the caller (it
  --    would raise 42501 for every signed-in read of that table).
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') INTO v_policies
    FROM pg_policies
   WHERE NOT (schemaname = 'public' AND tablename = ANY (v_tables))
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ ('\m(' || array_to_string(v_tables, '|') || ')\M');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 684: policies on other tables still read a closed table as the caller: %', v_policies;
  END IF;

  RAISE NOTICE 'mig 684: campaigns, campaign_recipients have no client privilege and no policy; every read and write is service_role.';
END $$;

COMMIT;
