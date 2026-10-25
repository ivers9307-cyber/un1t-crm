-- 692 — MEMBERWRITESWEEP.2 (C112) and MEMBERWRITESWEEP.3 (C121): no browser
-- or phone session reads or writes blocked_times, contact_events,
-- contact_tags, shift_block_removals, staff_allowances, scheduled_reports,
-- race_checkins, event_type_reminders, promo_codes, event_reminder_sends,
-- host_contacts or host_campaigns; anon holds nothing on the twelve. Every
-- read and write is server code on the service role. event_types keeps its
-- studio read (the phone embeds it from bookings) and nothing else.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 2 Oct 2026). Behaviour is
-- proven ahead of apply by
-- tests/migration-692-member-write-sweep-2-3-client-closed.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C112, found planning C101; C121, found building C101 1c)
-- ===========================================================================
-- Membership-only policies, any role at the studio:
--   blocked_times        FOR ALL: EXISTS event_types et ... auth_is_in_location(et.location_id)
--   contact_events,      FOR ALL: auth_is_master() OR location_id IS NULL OR
--   contact_tags         auth_is_in_location(location_id). The NULL branch admits
--                        EVERY signed-in user, customers included: a member could
--                        tag any contact, at any studio, by leaving location_id NULL.
--   race_checkins        FOR SELECT: auth_is_in_location(location_id)
--   event_type_reminders FOR SELECT via event_types and auth_is_in_location
-- Manager policies (writes straight from the browser, past the routes'
-- validation): shift_block_removals (SELECT/DELETE auth_is_manager_at, INSERT
-- also removed_by own), staff_allowances (I/U/D manager via the target's
-- profile_locations; SELECT own OR that), scheduled_reports (S/I/U/D
-- auth_is_manager_at), event_type_reminders (I/U/D master OR manager via
-- event_types). promo_codes, event_reminder_sends, host_contacts and
-- host_campaigns have NO policy, but authenticated still holds arwd: RLS is
-- their only fence (closed here as defence in depth).
--
-- VERIFIED LIVE (2 Oct, BEFORE this migration; migs 677 and 678 applied):
-- relacl {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
-- service_role=arwdDxtm/postgres} on all twelve (no anon); event_types
-- {...,authenticated=r/postgres,...} (mig 650). No column ACLs, RLS on (not
-- forced), owner postgres, in no publication, no dependent view. Rows:
-- blocked_times 0, contact_events 1,175, contact_tags 11,263 (no NULL
-- location), shift_block_removals 15, staff_allowances 1, scheduled_reports
-- 1, race_checkins 0, event_type_reminders 0, promo_codes 0,
-- event_reminder_sends 332, host_contacts 250, host_campaigns 7. A real plain
-- staff login at Stillorgan (auth_is_master() and auth_is_manager_at false)
-- reads 650 contact events and 11,115 contact tags; a real manager there
-- reads 15 slot removals, 1 allowance, 1 scheduled report; a real member
-- reads 0 everywhere. Triggers ON the tables: event_types and
-- event_type_reminders update_updated_at (INVOKER, NEW only), host_campaigns
-- host_campaigns_block_sent_delete (INVOKER, raises only). Triggers that
-- write or read them FROM another table: update_holiday_allowance (INVOKER,
-- writes staff_allowances) on time_off_requests, which clients cannot write
-- (authenticated=r); handle_new_booking and log_booking_status_change on
-- bookings read event_types and are SECURITY DEFINER. No policy outside the
-- twelve names one of them (blocked_times' and event_type_reminders' read
-- event_types, which stays readable). Client-executable functions naming
-- them: none (host_campaign_stats and tombstone_staff_profile are
-- service_role only). FK actions into the twelve run as the owner. Edge logs,
-- 24 h to 2 Oct 00:05 UTC (request.path and request.search, so embeds
-- included): every request to the thirteen is service_role; none from a client.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE ALL on the twelve from anon, authenticated and PUBLIC; drop their
--   19 policies. End state: no client privilege, RLS on, no policy (a client
--   read or write is 42501). event_types: the writes, TRUNCATE, REFERENCES,
--   TRIGGER and MAINTAIN revoked again and anon/PUBLIC emptied (all a no-op
--   on prod, which already reads authenticated=r): it keeps
--   event_types_select (studio read) because the phone embeds
--   event_types(...) from bookings (mobile/lib/bookings-api.js,
--   mobile/lib/contacts-api.js).
--
--   Writers and readers, all service_role, unchanged: src/lib/booking-slots.js
--   (blocked_times); src/lib/contact-events.js, /api/orders/[id],
--   /api/public/events/[slug]/check-member (contact_events);
--   /api/webhooks/glofox, /api/segments, audience-filter, contact-crossovers,
--   host-contact-list, contact-merge (contact_tags); /api/schedule/blocks*,
--   the copy-week/month routes via fetchSlotRemovalKeys
--   (shift_block_removals); /api/schedule/allowances, time-off-leave, the
--   assistant (staff_allowances); /api/schedule/reports/scheduled,
--   /api/cron/run-scheduled-reports (scheduled_reports);
--   /api/events/[id]/checkin* and the /events/[id]/checkin server page
--   (race_checkins; the staff phone goes through those routes);
--   /api/bookings/event-types/[id]/reminders, event-reminders
--   (event_type_reminders); /api/promo-codes*, the host promo routes, the
--   public register route (promo_codes); event-attendee-reminders
--   (event_reminder_sends); the host portal page and /api/host/emails*,
--   /api/public/host-list/[slug]/subscribe (host_contacts, host_campaigns).
--
-- CONSUMERS CHECKED (un1t-crm 449925fc incl. mobile/, shared/, desktop/ and
-- every src file that is 'use client', names createBrowserClient, calls
-- createAuthClient() or holds the anon key; champ-app 828ce00; champ-bridge,
-- un1t-platform, un1t-sentinel, un1t-pi): no client file reads, writes,
-- embeds or subscribes to any of the twelve; the client components that import
-- src/lib modules naming them (StaffForm, ScheduleReporting, ScheduleCalendar,
-- ContactMergeModal, AudienceBuilder, PromoCodesManager, EventCheckinClient,
-- HostEmails) import only pure helpers.
--
-- Guard: tests/member-write-sweep-guard.test.js (registry rows, mig 692,
-- rollback '2' for C112's six and '3' for C121's six).
-- APPLY: after this PR merges, apply 692 then 693; pre/post probes and the
-- two rollback records (POST-677 form) are in the PR body.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

REVOKE ALL
  ON public.blocked_times, public.contact_events, public.contact_tags, public.shift_block_removals,
     public.staff_allowances, public.scheduled_reports,
     public.race_checkins, public.event_type_reminders, public.promo_codes, public.event_reminder_sends,
     public.host_contacts, public.host_campaigns
  FROM anon, authenticated, PUBLIC;

-- event_types keeps its studio read; nothing else (a no-op on prod).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.event_types
  FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.event_types FROM anon, PUBLIC;

-- C112
DROP POLICY IF EXISTS blocked_times_via_event_type ON public.blocked_times;
DROP POLICY IF EXISTS contact_events_location_scoped ON public.contact_events;
DROP POLICY IF EXISTS contact_tags_location_scoped ON public.contact_tags;
DROP POLICY IF EXISTS shift_block_removals_select ON public.shift_block_removals;
DROP POLICY IF EXISTS shift_block_removals_insert ON public.shift_block_removals;
DROP POLICY IF EXISTS shift_block_removals_delete ON public.shift_block_removals;
DROP POLICY IF EXISTS staff_allowances_select ON public.staff_allowances;
DROP POLICY IF EXISTS staff_allowances_ins ON public.staff_allowances;
DROP POLICY IF EXISTS staff_allowances_upd ON public.staff_allowances;
DROP POLICY IF EXISTS staff_allowances_del ON public.staff_allowances;
DROP POLICY IF EXISTS scheduled_reports_select ON public.scheduled_reports;
DROP POLICY IF EXISTS scheduled_reports_ins ON public.scheduled_reports;
DROP POLICY IF EXISTS scheduled_reports_upd ON public.scheduled_reports;
DROP POLICY IF EXISTS scheduled_reports_del ON public.scheduled_reports;
-- C121
DROP POLICY IF EXISTS race_checkins_location_scoped_select ON public.race_checkins;
DROP POLICY IF EXISTS "event_type_reminders readable in-location" ON public.event_type_reminders;
DROP POLICY IF EXISTS event_type_reminders_ins ON public.event_type_reminders;
DROP POLICY IF EXISTS event_type_reminders_upd ON public.event_type_reminders;
DROP POLICY IF EXISTS event_type_reminders_del ON public.event_type_reminders;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Every
-- listed table has no client privilege at all, no policy, RLS on and
-- service_role DML; no policy elsewhere reads one of them as the caller; and
-- event_types is authenticated SELECT only with its one studio read. Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['blocked_times', 'contact_events', 'contact_tags', 'shift_block_removals',
                           'staff_allowances', 'scheduled_reports', 'race_checkins', 'event_type_reminders',
                           'promo_codes', 'event_reminder_sends', 'host_contacts', 'host_campaigns'];
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
      RAISE EXCEPTION 'mig 692: row level security is off on %', v_rel;
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
      RAISE EXCEPTION 'mig 692: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The real catalog (role membership, PUBLIC), one privilege per call;
    --    MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 692: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 692: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. The server still reads and writes.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 692: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 4. No policy left.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_policies
      FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 692: % should have no policy left: %', v_rel, v_policies;
    END IF;
  END LOOP;

  -- 5. No policy on another table reads a closed table as the caller (it
  --    would raise 42501 for every signed-in read of that table).
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') INTO v_policies
    FROM pg_policies
   WHERE NOT (schemaname = 'public' AND tablename = ANY (v_tables))
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ ('\m(' || array_to_string(v_tables, '|') || ')\M');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 692: policies on other tables still read a closed table as the caller: %', v_policies;
  END IF;

  -- 6. event_types: RLS on; authenticated SELECT and nothing else; anon and
  --    PUBLIC nothing; exactly its studio read.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.event_types'::regclass) THEN
    RAISE EXCEPTION 'mig 692: row level security is off on public.event_types';
  END IF;
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'event_types'
         AND (grantee IN ('anon', 'PUBLIC') OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'))
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'event_types'
         AND (grantee IN ('anon', 'PUBLIC') OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'))
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 692: client roles hold more than authenticated SELECT on public.event_types: %', v_extra;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF NOT (v_role = 'authenticated' AND v_priv = 'SELECT')
         AND has_table_privilege(v_role, 'public.event_types', v_priv) THEN
        RAISE EXCEPTION 'mig 692: % holds % on public.event_types', v_role, v_priv;
      END IF;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF NOT (v_role = 'authenticated' AND v_priv = 'SELECT')
         AND has_any_column_privilege(v_role, 'public.event_types', v_priv) THEN
        RAISE EXCEPTION 'mig 692: % holds column-level % on public.event_types', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.event_types', 'SELECT') THEN
    RAISE EXCEPTION 'mig 692: authenticated lost SELECT on public.event_types (the phone embeds it from bookings)';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_types') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'event_types' AND policyname = 'event_types_select'
                       AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles::text = '{authenticated}'
                       AND qual = 'private.auth_is_in_location(location_id)' AND with_check IS NULL) THEN
    RAISE EXCEPTION 'mig 692: public.event_types should keep exactly one policy, event_types_select FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id))';
  END IF;

  RAISE NOTICE 'mig 692: the twelve C112/C121 tables have no client privilege and no policy; event_types is authenticated SELECT only with its studio read; every write is service_role.';
END $$;

COMMIT;
