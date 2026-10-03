-- 701 — C138 (e): no browser or phone session writes bookings. The phone's
-- read (bookings_select, the phone `bookings` key) stays byte-identical; every
-- write is server code on the service role.
--
-- APPLY ONLY AFTER #1916 (WEB-3, C134 WEBBOOKINGWRITES.1) has been live on
-- production for at least 1 h: until its deploy, the web /bookings status pill
-- and reminder bell wrote bookings straight from the browser. A tab opened
-- before that deploy still runs the old bundle, and after this file its
-- toggles fail with a permission error (they now say so and revert): hard-
-- reload any open /bookings tab. Then re-run the edge-log check below.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 2 Oct 2026). Behaviour is
-- proven ahead of apply by tests/migration-701-bookings-client-writes-closed.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C138 e, found building WEB-3)
-- ===========================================================================
-- bookings carries three client WRITE policies TO authenticated:
--   bookings_insert  WITH CHECK location_id in the caller's phone-`bookings`
--                    studios (private.auth_mobile_can_location_ids, mig 691);
--   bookings_update  USING / WITH CHECK the same;
--   bookings_delete  USING private.auth_is_manager_at(location_id).
-- So anyone with the phone `bookings` toggle could, from their own login,
-- insert a booking at their studio or rewrite any of its bookings (status,
-- date, customer, reminders) past every route's checks (the web key, the
-- one-way cancel, the Glofox and reminder side effects), and a manager could
-- delete one outright. Since #1916 no app writes through them: the web uses
-- service-role routes (POST /api/bookings/[id]/status, /skip-reminder,
-- /cancel, /api/bookings/create), and the phone only reads.
--
-- VERIFIED LIVE (2 Oct 2026, BEFORE this migration; migs 677 and 691 applied):
-- relacl {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
-- service_role=arwdDxtm/postgres} (no anon), no column ACLs, RLS on (not
-- forced), owner postgres, in no publication, no dependent view. Exactly four
-- policies, the three above plus bookings_select (FOR SELECT TO authenticated
-- USING the phone-key studios); text pinned by the pre-check below.
-- Triggers: booking_created_trigger (handle_new_booking) and
-- booking_status_change_trigger (log_booking_status_change), both SECURITY
-- DEFINER, and bookings_updated_at (update_updated_at, INVOKER): server
-- writes still fire them. One policy elsewhere reads bookings as the caller,
-- "booking_reminder_sends readable" (SELECT; still works, SELECT is kept).
-- No function writes bookings as SECURITY INVOKER (none at all is callable by
-- a client that writes it). pg_stat_statements since its 19 Aug reset: the
-- authenticated role ran 0 INSERT/UPDATE/DELETE on bookings (117 read calls,
-- the phone's PostgREST reads); every write was service_role.
--
-- CONSUMERS CHECKED: un1t-crm src/ (no client file writes bookings; the C134
-- guard tests/bookings-web-client-writes-guard.test.js), mobile/ and shared/
-- (reads only: mobile/lib/bookings-api.js, mobile/lib/contacts-api.js,
-- shared/dashboard-data.js count), champ-app and champ-bridge (never name the
-- table; Glofox bookings live elsewhere). Server writers, all service_role:
-- the routes above, /api/public/book, src/lib/bookings-write.js (WhatsApp
-- Flow), src/lib/agent/booking-tools.js (Mia), src/lib/event-reminders.js.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE INSERT, UPDATE, DELETE (and TRUNCATE, REFERENCES, TRIGGER,
--   MAINTAIN, already gone since 677) from authenticated; REVOKE ALL from
--   anon and PUBLIC (a no-op since 677). Never SELECT: the phone reads it.
--   DROP the three write policies. bookings_select, the triggers and the
--   comments are untouched. End state: authenticated SELECT only, through
--   bookings_select; a client write is 42501.
--
-- ROLLBACK (post-677 form; run as one transaction):
--   BEGIN;
--   GRANT INSERT, UPDATE, DELETE ON public.bookings TO authenticated;
--   CREATE POLICY bookings_insert ON public.bookings FOR INSERT TO authenticated
--     WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('bookings'))::uuid[]));
--   CREATE POLICY bookings_update ON public.bookings FOR UPDATE TO authenticated
--     USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('bookings'))::uuid[]))
--     WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('bookings'))::uuid[]));
--   CREATE POLICY bookings_delete ON public.bookings FOR DELETE TO authenticated
--     USING (private.auth_is_manager_at(location_id));
--   COMMIT;
-- (The replay proves this text restores prod's exact policies and grants.)
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Pre-check: bookings is the table this file was written against. Every policy
-- on it is one of the four known ones with prod's exact text (a write policy
-- may already be gone: a second run is a no-op), and bookings_select is there.
-- Anything else aborts BEFORE a privilege or policy changes.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_phone text := '(location_id = ANY (( SELECT private.auth_mobile_can_location_ids(''bookings''::text) AS auth_mobile_can_location_ids)::uuid[]))';
  v_bad text;
BEGIN
  SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_bad
    FROM pg_policies p
   WHERE schemaname = 'public' AND tablename = 'bookings'
     AND NOT (
       permissive = 'PERMISSIVE' AND roles::text = '{authenticated}' AND (
            (policyname = 'bookings_select' AND cmd = 'SELECT' AND qual = v_phone AND with_check IS NULL)
         OR (policyname = 'bookings_insert' AND cmd = 'INSERT' AND qual IS NULL AND with_check = v_phone)
         OR (policyname = 'bookings_update' AND cmd = 'UPDATE' AND qual = v_phone AND with_check = v_phone)
         OR (policyname = 'bookings_delete' AND cmd = 'DELETE' AND qual = 'private.auth_is_manager_at(location_id)' AND with_check IS NULL)
       ));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 701: public.bookings carries a policy this file does not know (or a known one with other text): %', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bookings' AND policyname = 'bookings_select') THEN
    RAISE EXCEPTION 'mig 701: public.bookings has no bookings_select (the phone read); refusing to run';
  END IF;
END $$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.bookings
  FROM authenticated;
REVOKE ALL ON public.bookings FROM anon, PUBLIC;

DROP POLICY IF EXISTS bookings_insert ON public.bookings;
DROP POLICY IF EXISTS bookings_update ON public.bookings;
DROP POLICY IF EXISTS bookings_delete ON public.bookings;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). RLS on;
-- anon and PUBLIC hold nothing; authenticated holds SELECT and nothing else
-- (table and column level, any grantor, role membership included);
-- service_role keeps DML; exactly one policy, bookings_select, unchanged.
-- Any failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_phone text := '(location_id = ANY (( SELECT private.auth_mobile_can_location_ids(''bookings''::text) AS auth_mobile_can_location_ids)::uuid[]))';
  v_extra text;
  v_role text;
  v_priv text;
BEGIN
  -- 0. RLS on.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bookings'::regclass) THEN
    RAISE EXCEPTION 'mig 701: row level security is off on public.bookings';
  END IF;

  -- 1. information_schema, table and column level, any grantor.
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'bookings'
         AND (grantee IN ('anon', 'PUBLIC') OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'))
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'bookings'
         AND (grantee IN ('anon', 'PUBLIC') OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'))
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 701: client roles hold more than authenticated SELECT on public.bookings: %', v_extra;
  END IF;

  -- 2. The real catalog (role membership, PUBLIC), one privilege per call;
  --    MAINTAIN is not in information_schema.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF NOT (v_role = 'authenticated' AND v_priv = 'SELECT')
         AND has_table_privilege(v_role, 'public.bookings', v_priv) THEN
        RAISE EXCEPTION 'mig 701: % holds % on public.bookings', v_role, v_priv;
      END IF;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF NOT (v_role = 'authenticated' AND v_priv = 'SELECT')
         AND has_any_column_privilege(v_role, 'public.bookings', v_priv) THEN
        RAISE EXCEPTION 'mig 701: % holds column-level % on public.bookings', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- 3. The phone still reads; the server still reads and writes.
  IF NOT has_table_privilege('authenticated', 'public.bookings', 'SELECT') THEN
    RAISE EXCEPTION 'mig 701: authenticated lost SELECT on public.bookings (the phone reads it)';
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.bookings', v_priv) THEN
      RAISE EXCEPTION 'mig 701: service_role lost % on public.bookings', v_priv;
    END IF;
  END LOOP;

  -- 4. Exactly bookings_select, unchanged.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bookings') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'bookings' AND policyname = 'bookings_select'
                       AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles::text = '{authenticated}'
                       AND qual = v_phone AND with_check IS NULL) THEN
    RAISE EXCEPTION 'mig 701: public.bookings should keep exactly one policy, bookings_select FOR SELECT TO authenticated on the phone bookings key';
  END IF;

  RAISE NOTICE 'mig 701: bookings is authenticated SELECT only, through bookings_select; every write is service_role.';
END $$;

COMMIT;
