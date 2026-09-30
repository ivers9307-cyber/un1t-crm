-- 668 — GRANTSWEEP.1: the staff scheduling tables hold only the client
-- privileges a browser or phone actually uses.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-668-scheduling-tables-client-grants.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C15, found planning C8)
-- ===========================================================================
-- C8 (mig 646) asked whether the rows-not-columns gap it closed on the shift
-- tables also exists on shift_swap_requests, time_off_requests and
-- staff_attendance_events. Measured per table (a gap is a leak only when the
-- row policy admits rows whose columns the API keeps from that reader):
--
--   staff_attendance_events — LEAK. Its one policy ("Staff read attendance at
--     their locations", TO public) admits EVERY row at any studio the caller
--     belongs to, and anon/authenticated keep Supabase's default arwdDxtm. So
--     any plain coach reads every colleague's door and geofence events
--     (event_at, source, match_outcome, unifi ids) and `payload` (the phone's
--     device name for a geofence event, the raw UniFi alarm for a door
--     event), plus door events of people who are not staff at all
--     (match_outcome 'unknown_user'). The API never serves a coach any of it:
--     /api/attendance is a manager report, and ARRIVALSHOW.1 / mig 646 hide
--     colleagues' arrival stamps from coaches.
--   shift_swap_requests — NOT a column leak: the row policy (manager at the
--     studio, the requester, the target) is exactly the set the API shows
--     `reason` and `review_note` to (GET /api/schedule/swaps: managers see
--     all, a coach sees them only on a swap they are party to). But it IS a
--     live WRITE hole: shift_swap_requests_insert lets any member of a studio
--     insert a swap from their own login with requester_id = themselves and
--     ANY requester_shift_id (a colleague's shift), target and status
--     ('awaiting_approval' or even 'approved'), skipping every check POST
--     /api/schedule/swaps makes (own shift, published, future, one open swap
--     per shift); and _update/_delete let a manager-tier browser rewrite or
--     delete a swap without the approve RPCs, the shift move or the notices.
--   time_off_requests — NOT a leak: the row policy (own rows, or a manager at
--     the studio) is the same set or narrower than GET /api/schedule/time-off
--     serves the four note/reason columns to. Writes were already taken off
--     by migs 624/625; anon still holds SELECT and both roles MAINTAIN.
--   shift_blocks / shift_assignments (mig 646) — anon still holds
--     awdDxtm and authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN.
--   locations — the C23 note (anon/authenticated UPDATE, `settings` fenced
--     only by RLS) was closed by mig 648: no table-level client privilege,
--     `settings` neither readable nor writable by any client role. Not
--     touched here.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   relacl shift_swap_requests, staff_attendance_events: anon=arwdDxtm,
--   authenticated=arwdDxtm; time_off_requests: anon=rm, authenticated=rm;
--   shift_blocks, shift_assignments: anon=awdDxtm, authenticated=awdDxtm
--   (+ mig 646's column SELECT list). No PUBLIC grant. No column ACL on the
--   three. RLS on, not forced, on all five. None is in supabase_realtime; no
--   view depends on them; no policy on another table references them.
--   As a plain `staff` coach at Stillorgan (SET LOCAL ROLE authenticated +
--   their JWT sub, rolled back): 456 attendance events visible, 438 not
--   their own (292 colleagues', 146 unknown-user door events), payload
--   readable on all 438; 192 colleague geofence entries outside any shift;
--   swaps visible 1, time off visible 11 (all own). The swap INSERT policy's
--   WITH CHECK is true for them, and 18 colleagues' future assignment ids
--   are visible to them to aim it at.
--   Edge logs (two 24 h windows to 30 Sep 09:00Z): the only non-service_role
--   requests on the three tables were the phone's two authenticated GETs
--   (swaps: id,status,reason,created_at,target_id,requester_shift_id + the
--   block embed; time off: id,type,start_date,end_date,status,created_at).
--   No client read of staff_attendance_events, no client write anywhere, no
--   anon request.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   staff_attendance_events: REVOKE ALL from anon, authenticated, PUBLIC and
--     drop its only policy. Service role only (RLS on, no policy), like
--     audit_events (mig 655). Nothing client-side reads it.
--   shift_swap_requests: anon and PUBLIC get nothing; authenticated keeps
--     SELECT only (the phone's Today "My requests" list reads `reason`);
--     the INSERT/UPDATE/DELETE policies go; shift_swap_requests_select is
--     untouched. Every writer is a service-role /api/schedule/swaps route.
--   time_off_requests: anon and PUBLIC get nothing; authenticated keeps
--     SELECT only (MAINTAIN revoked; the write list is named again so the
--     end state is this file's claim, a no-op after 625).
--   shift_blocks, shift_assignments: anon and PUBLIC get nothing;
--     authenticated loses TRUNCATE, REFERENCES, TRIGGER, MAINTAIN. Mig 646's
--     column SELECT list and authenticated INSERT/UPDATE/DELETE (behind the
--     manager write policies) are NOT changed; the self-check proves both.
--   No table-level REVOKE SELECT from authenticated on the two shift tables:
--   a table-level REVOKE also revokes that privilege on every column, which
--   would wipe mig 646's column grants and blank the phone's Today tab.
--
-- CONSUMERS CHECKED (origin/main 612930f5, client readers re-checked at
-- d8156162; champ-app 828ce00; champ-bridge, un1t-platform, un1t-sentinel,
-- un1t-pi, un1t-finance-agent: no reference):
--   Grant-bound readers are only shared/dashboard-data.js (phone Today): the
--   two GETs above, both kept. mobile/ calls /api/schedule/* and
--   /api/attendance/* only. No 'use client' / createBrowserClient file reads
--   or writes the three tables. 539 historical versions of every shared/ or
--   mobile/ file that named them (since 1 Apr): no write, no read of
--   staff_attendance_events, no swap/time-off column outside what stays
--   readable. Functions that touch them (tombstone_staff_profile, the three
--   approve_*_shift_swap) are INVOKER and executable by service_role only.
--
-- Guard: tests/scheduling-client-grants-guard.test.js.
--
-- APPLY: after this PR merges, same day. Pre/post probes and the rollback
-- record are in docs/superpowers/plans/2026-09-27-followups/C15-GRANTSWEEP.1.md
-- (Task 5).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on tables the swap, leave and door
-- routes write. Abort after 5 s rather than queue them; nothing is
-- half-applied, re-run later.
SET LOCAL lock_timeout = '5s';

-- The read rules this file promises not to change, as this session renders
-- them, for the self-check.
CREATE TEMP TABLE mig668_kept_read_rule ON COMMIT DROP AS
  SELECT tablename::text AS tablename, policyname::text AS policyname, qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (tablename, policyname) IN (
       ('shift_swap_requests', 'shift_swap_requests_select'),
       ('time_off_requests', 'time_off_requests_select'));

-- Mig 646's column grants, which this file must leave exactly as they are.
CREATE TEMP TABLE mig668_shift_columns ON COMMIT DROP AS
  SELECT table_name::text AS table_name, column_name::text AS column_name
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name IN ('shift_blocks', 'shift_assignments')
     AND grantee = 'authenticated' AND privilege_type = 'SELECT';

-- ── A. staff_attendance_events: service role only ──────────────────────
DROP POLICY IF EXISTS "Staff read attendance at their locations" ON public.staff_attendance_events;
REVOKE ALL ON public.staff_attendance_events FROM anon, authenticated, PUBLIC;

COMMENT ON TABLE public.staff_attendance_events IS
  'Door (UniFi Access) and geofence arrival events. Service role only (GRANTSWEEP.1, mig 668): no client grant, RLS on with no policy. Managers read it through /api/attendance.';

-- ── B. shift_swap_requests: read-only for authenticated ────────────────
REVOKE ALL ON public.shift_swap_requests FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.shift_swap_requests FROM authenticated;
DROP POLICY IF EXISTS shift_swap_requests_insert ON public.shift_swap_requests;
DROP POLICY IF EXISTS shift_swap_requests_update ON public.shift_swap_requests;
DROP POLICY IF EXISTS shift_swap_requests_delete ON public.shift_swap_requests;

-- ── C. time_off_requests: read-only for authenticated ──────────────────
REVOKE ALL ON public.time_off_requests FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.time_off_requests FROM authenticated;

-- ── D. shift_blocks, shift_assignments: anon nothing, no DDL-ish privs ─
REVOKE ALL ON public.shift_blocks, public.shift_assignments FROM anon, PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.shift_blocks, public.shift_assignments FROM authenticated;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back. has_table_privilege and
-- has_any_column_privilege with a comma list are true when ANY privilege is
-- held, so every role and privilege is its own call. MAINTAIN is Postgres
-- 17's `m`; information_schema does not show it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_all_privs text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  v_col_privs text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
  v_tbl  text;
  v_rel  text;
  v_role text;
  v_priv text;
  v_n    int;
  v_diff text;
BEGIN
  -- 0. The server keeps full DML on all five.
  FOREACH v_tbl IN ARRAY ARRAY['staff_attendance_events', 'shift_swap_requests', 'time_off_requests', 'shift_blocks', 'shift_assignments'] LOOP
    v_rel := 'public.' || v_tbl;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'GRANTSWEEP.1: service_role lacks % on %', v_priv, v_rel;
      END IF;
    END LOOP;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
      RAISE EXCEPTION 'GRANTSWEEP.1: RLS is off on %', v_rel;
    END IF;

    -- 1. anon and PUBLIC hold nothing, at table or column level, on any of the five.
    FOREACH v_role IN ARRAY ARRAY['anon', 'public'] LOOP
      FOREACH v_priv IN ARRAY v_all_privs LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'GRANTSWEEP.1: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY v_col_privs LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'GRANTSWEEP.1: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 2. authenticated never holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN.
    FOREACH v_priv IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege('authenticated', v_rel, v_priv) THEN
        RAISE EXCEPTION 'GRANTSWEEP.1: authenticated still holds % on %', v_priv, v_rel;
      END IF;
    END LOOP;
    IF has_any_column_privilege('authenticated', v_rel, 'REFERENCES') THEN
      RAISE EXCEPTION 'GRANTSWEEP.1: authenticated still holds column-level REFERENCES on %', v_rel;
    END IF;
  END LOOP;

  -- 3. staff_attendance_events: nothing for authenticated either, and no policy.
  FOREACH v_priv IN ARRAY v_all_privs LOOP
    IF has_table_privilege('authenticated', 'public.staff_attendance_events', v_priv) THEN
      RAISE EXCEPTION 'GRANTSWEEP.1: authenticated still holds % on public.staff_attendance_events', v_priv;
    END IF;
  END LOOP;
  FOREACH v_priv IN ARRAY v_col_privs LOOP
    IF has_any_column_privilege('authenticated', 'public.staff_attendance_events', v_priv) THEN
      RAISE EXCEPTION 'GRANTSWEEP.1: authenticated still holds column-level % on public.staff_attendance_events', v_priv;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff_attendance_events';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'GRANTSWEEP.1: public.staff_attendance_events should have no policy, has %', v_n;
  END IF;

  -- 4. Swaps and time off: authenticated reads (the phone), writes nothing,
  --    and exactly one policy, the SELECT one this file did not touch.
  FOREACH v_tbl IN ARRAY ARRAY['shift_swap_requests', 'time_off_requests'] LOOP
    v_rel := 'public.' || v_tbl;
    IF NOT has_table_privilege('authenticated', v_rel, 'SELECT') THEN
      RAISE EXCEPTION 'GRANTSWEEP.1: authenticated lost SELECT on % (the phone reads it)', v_rel;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('authenticated', v_rel, v_priv) THEN
        RAISE EXCEPTION 'GRANTSWEEP.1: authenticated still holds % on %', v_priv, v_rel;
      END IF;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
      IF has_any_column_privilege('authenticated', v_rel, v_priv) THEN
        RAISE EXCEPTION 'GRANTSWEEP.1: authenticated still holds column-level % on %', v_priv, v_rel;
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policies p JOIN mig668_kept_read_rule k
                         ON k.tablename = p.tablename AND k.policyname = p.policyname AND k.qual = p.qual
                       WHERE p.schemaname = 'public' AND p.tablename = v_tbl
                         AND p.cmd = 'SELECT' AND p.permissive = 'PERMISSIVE'
                         AND p.roles = ARRAY['authenticated']::name[]) THEN
      RAISE EXCEPTION 'GRANTSWEEP.1: % should keep exactly one policy, its unchanged SELECT policy', v_rel;
    END IF;
  END LOOP;

  -- 5. The shift tables: mig 646's column list unchanged, still no table
  --    SELECT, and the manager-policy writes untouched.
  SELECT string_agg(coalesce(b.table_name, a.table_name) || '.' || coalesce(b.column_name, a.column_name), ', ')
    INTO v_diff
    FROM mig668_shift_columns b
    FULL JOIN (SELECT table_name::text AS table_name, column_name::text AS column_name
                 FROM information_schema.column_privileges
                WHERE table_schema = 'public' AND table_name IN ('shift_blocks', 'shift_assignments')
                  AND grantee = 'authenticated' AND privilege_type = 'SELECT') a
      ON a.table_name = b.table_name AND a.column_name = b.column_name
   WHERE a.column_name IS NULL OR b.column_name IS NULL;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'GRANTSWEEP.1: mig 646''s authenticated column SELECT list changed: %', v_diff;
  END IF;
  FOREACH v_tbl IN ARRAY ARRAY['shift_blocks', 'shift_assignments'] LOOP
    v_rel := 'public.' || v_tbl;
    IF has_table_privilege('authenticated', v_rel, 'SELECT') THEN
      RAISE EXCEPTION 'GRANTSWEEP.1: authenticated holds table-level SELECT on % (reopens mig 646)', v_rel;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('authenticated', v_rel, v_priv) THEN
        RAISE EXCEPTION 'GRANTSWEEP.1: authenticated lost % on % (this file promises not to touch it)', v_priv, v_rel;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'GRANTSWEEP.1 mig 668: staff_attendance_events service-role only; shift_swap_requests and time_off_requests read-only for authenticated; anon holds nothing on the five scheduling tables.';
END $$;

COMMIT;
