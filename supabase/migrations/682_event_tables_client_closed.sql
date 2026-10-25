-- 682 — MEMBERWRITESWEEP.1c: no browser or phone session reads or writes
-- race_events, teams, race_registrations, race_payments, race_penalties,
-- race_waves or team_members; anon holds nothing on the seven. Every read and
-- write is server code on the service role.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026). Behaviour is
-- proven ahead of apply by tests/migration-682-event-tables-client-closed.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C101, seen planning C94: its F2)
-- ===========================================================================
-- Each of the seven carries one FOR ALL policy TO authenticated whose only
-- test is studio membership: race_events and teams
-- (auth_is_master() OR auth_is_in_location(location_id)); the children
-- race_registrations, race_payments and race_waves through their event
-- (EXISTS ... race_events re ... auth_is_in_location(re.location_id)),
-- race_penalties through its registration's event, and team_members through
-- its team. The routes are narrower: /api/races*, /api/events*, the
-- /api/registrations/[id] actions (cancel, penalties, race-start ...),
-- /api/team-members/[id] and
-- /api/teams/[id]/members need the 'races' permission, plus MANAGER_ROLES or
-- ADMIN_ROLES for writes. So any plain staff member could, from their own
-- login, read 11 events, 182 registrations and 222 payment records at
-- Stillorgan, mark a payment paid, edit registrations, add or clear
-- penalties, move team members and delete waves.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration; mig 677 already applied):
-- relacl {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
-- service_role=arwdDxtm/postgres} on all seven (no anon), no column ACLs,
-- RLS on (not forced), owner postgres, in no publication, no dependent view,
-- exactly the seven policies above. Triggers ON the seven:
-- race_events_touch_updated_at, teams_touch_updated_at,
-- race_registrations_touch_updated_at, race_payments_touch_updated_at,
-- race_waves_touch_updated_at, each private.touch_<table>_updated_at,
-- SECURITY INVOKER, naming no other table. No trigger on any OTHER table has
-- a function that names one of the seven, so no trigger writes them as the
-- caller. No policy on another table names any of the seven. Functions
-- naming them: public.campaign_outcome_stats (INVOKER; EXECUTE for
-- service_role only). FK actions into the seven (cascade / set null from
-- race_checkins, event_reminder_sends, promo_codes, bookings, host_contacts,
-- host_campaigns) run as the table owner. A real plain staff login at
-- Stillorgan (auth_is_master() false) reads 11 events, 189 teams, 182
-- registrations, 222 payments, 0 penalties, 53 waves and 241 team members,
-- and EXPLAIN UPDATE public.race_payments plans with only the policy as its
-- filter. Edge logs, 25 Sep 20:30 to 30 Sep 20:40 UTC (five 24 h windows,
-- request.path and request.url, so embeds included): every request to the
-- seven is service_role; none from a client.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE ALL on the seven from anon, authenticated and PUBLIC (the writes,
--   the reads, and TRUNCATE, REFERENCES, TRIGGER, MAINTAIN where they are
--   still held). Drop the seven policies. End state: no client privilege,
--   RLS on, no policy (a client read or write is 42501).
--
--   The children close with their parents: each child policy reads its
--   parent AS THE CALLER, so revoking race_events or teams alone would turn
--   every signed-in read of race_registrations, race_payments, race_waves,
--   race_penalties or team_members into a 42501 (check 5 below refuses to
--   finish while any policy outside this file still names one of the seven).
--
--   Writers and readers, all service_role, unchanged: /api/races*,
--   /api/events*, the /api/registrations/[id] actions,
--   /api/event-registrations/[id],
--   /api/team-members/[id], /api/teams/[id]/members,
--   /api/public/{events,races}/[slug]/register and the other public event
--   routes, /api/public/event-{payments,registrations}/[id], the host routes
--   (/api/host/..., /api/hosts/pending-events), /api/webhooks/revolut/race-payments,
--   /api/webhooks/stripe, /api/cron/race-timing-events, /api/orders/[id]*,
--   src/lib/race-payments.js, race-cancel, race-confirmations,
--   race-register-solo, race-control, event-attendee-reminders, orders,
--   host-revenue, attendee-export, audience-filter, the agent's event tools,
--   and the server pages under /events, /event/[slug], /embed/event/[slug],
--   /host, /welcome/[location]/events and /settings/landing-page
--   (createServerClient). The staff phone's check-in screen goes through
--   /api/events/[id]/checkin*. un1t-sentinel reads race_* with its service key.
--
-- CONSUMERS CHECKED (un1t-crm 015c3937 incl. mobile/, shared/, desktop/;
-- champ-app origin/main; un1t-sentinel; champ-bridge; un1t-platform;
-- un1t-pi): no client file reads, writes, embeds or subscribes to any of the
-- seven; the client components RaceControlPanel and RaceDisplayBoard import
-- only pure formatters from src/lib/race-control.js.
--
-- Guard: tests/member-write-sweep-guard.test.js (registry rows, mig 682).
-- APPLY: after this PR merges, per docs/superpowers/plans/2026-09-27-followups/
-- C101-MEMBERWRITESWEEP.1.md, Task 1c-5 (pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

REVOKE ALL
  ON public.race_events, public.teams, public.race_registrations, public.race_payments,
     public.race_penalties, public.race_waves, public.team_members
  FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS race_penalties_location_scoped ON public.race_penalties;
DROP POLICY IF EXISTS race_registrations_location_scoped ON public.race_registrations;
DROP POLICY IF EXISTS race_payments_location_scoped ON public.race_payments;
DROP POLICY IF EXISTS race_waves_location_scoped ON public.race_waves;
DROP POLICY IF EXISTS team_members_location_scoped ON public.team_members;
DROP POLICY IF EXISTS teams_location_scoped ON public.teams;
DROP POLICY IF EXISTS race_events_location_scoped ON public.race_events;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Every
-- listed table has no client privilege at all, no policy, RLS on and
-- service_role DML; and no policy elsewhere reads one of them as the caller.
-- Any failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['race_events', 'teams', 'race_registrations', 'race_payments', 'race_penalties', 'race_waves', 'team_members'];
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
      RAISE EXCEPTION 'mig 682: row level security is off on %', v_rel;
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
      RAISE EXCEPTION 'mig 682: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The real catalog (role membership, PUBLIC), one privilege per call;
    --    MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 682: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 682: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. The server still reads and writes.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 682: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 4. No policy left.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_policies
      FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 682: % should have no policy left: %', v_rel, v_policies;
    END IF;
  END LOOP;

  -- 5. No policy on another table reads a closed table as the caller (it
  --    would raise 42501 for every signed-in read of that table).
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') INTO v_policies
    FROM pg_policies
   WHERE NOT (schemaname = 'public' AND tablename = ANY (v_tables))
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ ('\m(' || array_to_string(v_tables, '|') || ')\M');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 682: policies on other tables still read a closed table as the caller: %', v_policies;
  END IF;

  RAISE NOTICE 'mig 682: race_events, teams, race_registrations, race_payments, race_penalties, race_waves, team_members have no client privilege and no policy; every read and write is service_role.';
END $$;

COMMIT;
