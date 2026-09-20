-- 622 — STAFFDELETE.1: a permanently deleted staff member becomes a TOMBSTONE.
--
-- WHY. DELETE /api/staff/[id]/permanent deleted the profiles row. profiles.id
-- is REFERENCES auth.users(id) ON DELETE CASCADE (mig 004:36), and these all
-- CASCADE off profiles: shift_assignments.profile_id (067),
-- time_off_requests.profile_id + staff_allowances.profile_id (011),
-- schedule_notifications.profile_id (010), contractor_invoices.contractor_id
-- (101:19), profile_compensation.profile_id (152), fte_expense_claims (183),
-- card_receipts (266), policy_acknowledgements (178), checklist_instances
-- (215), assignment_change_log.target_profile_id (080). So "permanent delete"
-- destroyed the payroll, leave and invoice history the business must keep,
-- while the route's own header promised the opposite.
--
-- OWNER'S DECISION: permanent delete removes the person from UPCOMING shifts
-- only and must NOT change history; past shifts, leave, invoices and reports
-- stay look-up-able and reportable BY NAME.
--
-- "UPCOMING" MEANS NOT STARTED. A shift is removed only when
--   block_date > Dublin today, OR
--   block_date = Dublin today AND effective start > Dublin wall-clock now,
-- where effective start = COALESCE(shift_assignments.start_time_override,
-- shift_blocks.start_time) — the assignment -> block precedence the app uses
-- (shift_blocks.start_time is NOT NULL, mig 067:70; blocks snapshot their
-- times, so no template fallback). A shift in progress, finished today, or
-- starting EXACTLY now has started: it is HISTORY and stays. So does a shift
-- the person has ALREADY ARRIVED for (arrived_at set, or an attendance event
-- matched to it — arrivals match up to 45 min early), so
-- staff_attendance_events.matched_assignment_id (mig 120:79, ON DELETE SET
-- NULL) is never unlinked from a worked shift. Dublin date and time are both
-- derived in SQL from ONE instant (p_now AT TIME ZONE 'Europe/Dublin'), so the
-- date and the clock can never disagree across midnight or a DST change.
--
-- THE ROLE IS DEMOTED, AND REMEMBERED. RLS reads profiles.role LIVE:
-- private.auth_is_master() / private.auth_role() (mig 051:125-215, called from
-- ~65 migrations' policies) and dozens of inline `p.role = 'master' OR p.role
-- = 'owner'` policies (migs 152, 178, 179, 183, 184, 228, 320) decide from
-- profiles.role alone — none looks at active or deleted_at. A tombstone that
-- kept role='master' would stay a master at the RLS layer (browser / mobile
-- client, anon key + the person's own JWT) for up to an hour after a ban, and
-- FOREVER when the login is deliberately kept (same account is a member or a
-- host) or the ban call fails. So the function copies role into deleted_role
-- and sets role to the floor, 'staff', in the SAME transaction. profiles.role
-- has no CHECK (mig 004:39: TEXT NOT NULL DEFAULT 'staff'); 'staff' is the
-- column DEFAULT and the lowest rung of every role CHECK that exists
-- (profile_locations mig 051:46, location_role_permissions mig 364:31), and no
-- policy grants anything to role='staff' without a profile_locations row —
-- which the function deletes. The only other per-person staff role carriers
-- are profile_locations.role and profile_organizations.role ('org_admin', mig
-- 417): both tables are emptied for the person in step 7. Role HISTORY is
-- deleted_role (src/lib/staff-tombstone.js roleAtDeletion()).
--
-- WHAT THIS FILE DOES
--   1. profiles.deleted_at / deleted_by / deleted_role, and a CHECK that a
--      tombstone is never active, always remembers its role, and always sits
--      at role='staff' — so a reactivation OR a re-promotion is refused by the
--      database, not just the UI.
--   2. public.tombstone_staff_profile(profile, actor, now, dry_run): ONE
--      transaction that removes NOT-STARTED assignments (logging the published
--      ones), cancels open swaps and still-ahead pending leave, deletes access
--      rows and tokens, strips PII from the profile while KEEPING full_name,
--      employment_type and pay, moves role into deleted_role and demotes role
--      to 'staff', and redacts the PII that the mig 191 audit trigger re-saves
--      while it does so. dry_run returns the same summary and writes nothing.
--   It never deletes from profiles, and nothing here touches auth.users: the
--   route bans the auth user instead, because deleting it would cascade
--   straight back through profiles.
--
-- SAFE ALONE: yes. Nullable columns, a CHECK every existing row passes (it
-- binds only rows with deleted_at set, and there are none), one
-- partial index, a function nobody calls until the code deploys; three
-- triggers that only ever fire for a row with deleted_at set (none exist); and
-- a REVOKE of write grants that no client uses (every profiles write in the
-- codebase is service-role — list in the REVOKE section). Apply BEFORE
-- merging the code: excludeTombstones() filters on deleted_at and PostgREST
-- 400s on a column that does not exist.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run them and keep the output)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The FK truth, from the live catalog. Compare with the table in
--     docs/superpowers/plans/2026-09-19-scheduler-wave1/09-STAFFDELETE.1.md.
--     confdeltype: c=CASCADE n=SET NULL r=RESTRICT a=NO ACTION.
--
--       SELECT c.conrelid::regclass AS tbl, a.attname AS col, c.confdeltype
--         FROM pg_constraint c
--         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
--        WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass
--        ORDER BY c.confdeltype, 1, 2;
--     Expected: ~131 rows (24 CASCADE, 48 NO ACTION, 2 RESTRICT, 57 SET NULL by the migrations). Any CASCADE table NOT in the plan's table is a
--     history table this design already protects (nothing is deleted) — note
--     it, do not stop. A NEW access/credential table is worth adding to
--     section 7 of the function in a follow-up.
--
-- (b) profiles.id -> auth.users must read 'c' (CASCADE). That is the reason
--     the auth user is banned, never deleted:
--
--       SELECT confdeltype FROM pg_constraint
--        WHERE conrelid = 'public.profiles'::regclass AND contype = 'f'
--          AND confrelid = 'auth.users'::regclass;
--
-- (b2) Nothing may CASCADE off shift_assignments: the function deletes
--     not-started assignments, and a cascade there would take swap history
--     with them. By the migrations every FK in is SET NULL (mig 603 replaced
--     mig 237's CASCADE on shift_swap_requests.requester_shift_id; also
--     target_shift_id, schedule_notifications.shift_id,
--     staff_attendance_events.matched_assignment_id):
--
--       SELECT c.conrelid::regclass AS tbl, c.conname, c.confdeltype
--         FROM pg_constraint c
--        WHERE c.contype = 'f' AND c.confrelid = 'public.shift_assignments'::regclass;
--     Expected: every row confdeltype = 'n'. A 'c' row means STOP — do not
--     run a permanent delete until that FK is SET NULL.
--
-- (c) Has the OLD route half-run in prod? It writes its audit row and nulls
--     ~21 attribution columns BEFORE failing on the dropped public.shifts:
--
--       SELECT to_regclass('public.shifts') AS shifts_table;   -- expected NULL (mig 238)
--       SELECT l.created_at, l.actor_id, l.target_profile_id, (p.id IS NOT NULL) AS profile_still_exists
--         FROM public.assignment_change_log l
--         LEFT JOIN public.profiles p ON p.id = l.target_profile_id
--        WHERE l.action = 'permanent_delete' ORDER BY l.created_at DESC;
--     Expected: zero rows, or rows whose profile_still_exists = true (attempts
--     that aborted). A row cannot show profile_still_exists = false — the log
--     row cascades with the profile — so a COMPLETED old delete leaves no
--     trace here at all. Report what you see to the owner either way.
--
-- (d) Every table the function touches exists:
--
--       SELECT t, to_regclass('public.' || t) IS NOT NULL AS ok
--         FROM unnest(ARRAY['shift_assignments','shift_blocks','rosters','shift_templates','locations',
--           'shift_swap_requests','time_off_requests','staff_allowances','contractor_invoices',
--           'schedule_notifications','roster_change_log','profile_locations','profile_organizations',
--           'device_tokens','widget_tokens','email_mailbox_access','mobile_bar_prefs','audit_events']) AS t;
--     Expected: ok = true on every row. A false one makes the FUNCTION fail at
--     call time (not this file) — stop and fix the name.
--
-- (e) Baseline for the first real delete — run for the profile you are about
--     to delete and KEEP the numbers; (h) below must reproduce them:
--
--     (past = STARTED, upcoming = NOT STARTED — the function's own rule; run
--     it immediately before the delete, since "now" moves.)
--
--       WITH n AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d, (now() AT TIME ZONE 'Europe/Dublin')::time AS t),
--            s AS (SELECT (b.block_date > n.d OR (b.block_date = n.d AND COALESCE(a.start_time_override, b.start_time) > n.t)) AS not_started
--                    FROM public.shift_assignments a JOIN public.shift_blocks b ON b.id = a.block_id CROSS JOIN n
--                   WHERE a.profile_id = :id)
--       SELECT (SELECT count(*) FROM s WHERE not_started IS NOT TRUE) AS past_shifts,
--              (SELECT count(*) FROM s WHERE not_started)             AS upcoming_shifts,
--              (SELECT count(*) FROM public.time_off_requests   WHERE profile_id = :id)    AS leave_rows,
--              (SELECT count(*) FROM public.staff_allowances    WHERE profile_id = :id)    AS allowance_rows,
--              (SELECT count(*) FROM public.contractor_invoices WHERE contractor_id = :id) AS invoices;
--
-- (e2) The grants this file revokes — keep the output (it is the rollback
--     recipe, should one ever be needed):
--
--       SELECT grantee, privilege_type, NULL AS column_name FROM information_schema.table_privileges
--        WHERE table_schema='public' AND table_name='profiles' AND grantee IN ('anon','authenticated')
--       UNION ALL
--       SELECT grantee, privilege_type, column_name FROM information_schema.column_privileges
--        WHERE table_schema='public' AND table_name='profiles' AND grantee IN ('anon','authenticated')
--        ORDER BY 1, 2, 3;
--     Expected today: INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER at
--     table level and INSERT/UPDATE/REFERENCES per column; no table-level
--     SELECT (mig 153b). Any column-level SELECT rows are left untouched.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (f0) Re-run (e2). Expected: NO row whose privilege_type is not SELECT (the
--     file's own DO block already refuses to commit otherwise), and the SELECT
--     rows identical to before.
-- (f) SELECT column_name FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='profiles' AND column_name IN ('deleted_at','deleted_by','deleted_role','auth_disposition','auth_completed_at');  -- 5 rows
--     SELECT conname FROM pg_constraint WHERE conname = 'profiles_tombstone_is_inactive';                     -- 1 row
--     SELECT has_function_privilege('authenticated', 'public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)', 'EXECUTE');  -- false
--     SELECT count(*) FROM public.profiles WHERE deleted_at IS NOT NULL;                                      -- 0
-- (g) get_advisors (type = security). Expected: nothing new.
--
-- AFTER THE FIRST REAL DELETE (code deployed):
-- (h) Re-run (e): past_shifts, leave_rows, allowance_rows, invoices UNCHANGED;
--     upcoming_shifts = 0.
-- (i) SELECT full_name, email, active, role, deleted_role, deleted_at, deleted_by, avatar_url, pin_hash FROM public.profiles WHERE id = :id;
--     -- name intact, email 'deleted+<id>@deleted.invalid', active false, role 'staff', deleted_role = what they were, deleted_* set, the rest NULL
--     SELECT auth_disposition, auth_completed_at FROM public.profiles WHERE id = :id;
--     -- both set. auth_completed_at NULL = the login step did NOT finish: re-send
--     -- DELETE /api/staff/<id>/permanent (it re-runs only that step).
--     SELECT email, banned_until FROM auth.users WHERE id = :id;
--     -- scrambled + banned_until ~100 years out, UNLESS the response said auth = kept_*
--     SELECT count(*) FROM public.profile_locations WHERE profile_id = :id;   -- 0
--     SELECT p.full_name, count(*) FROM public.shift_assignments a JOIN public.profiles p ON p.id = a.profile_id
--      WHERE a.profile_id = :id GROUP BY 1;                                    -- their name, past_shifts

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_role text,
  ADD COLUMN IF NOT EXISTS auth_disposition text,
  ADD COLUMN IF NOT EXISTS auth_completed_at timestamptz;

COMMENT ON COLUMN public.profiles.deleted_at IS
  'STAFFDELETE.1 (mig 622): set = TOMBSTONE. The person was permanently deleted: PII stripped, access rows gone, auth user banned, full_name kept so history stays reportable by name. Readers that list profiles must exclude these (src/lib/staff-tombstone.js). Never DELETE the row: ~25 tables cascade off it.';
COMMENT ON COLUMN public.profiles.deleted_by IS
  'STAFFDELETE.1 (mig 622): the master who ran the permanent delete.';
COMMENT ON COLUMN public.profiles.deleted_role IS
  'STAFFDELETE.1 (mig 622): the role the person held when they were permanently deleted. profiles.role is demoted to ''staff'' on a tombstone because RLS reads it live (private.auth_is_master() and inline role policies) — role HISTORY is this column. NULL on every living profile.';

COMMENT ON COLUMN public.profiles.auth_disposition IS
  'STAFFDELETE.1 (mig 622): the FINAL outcome of the login step of a permanent delete — ban | kept_member_login | kept_host_login. The ban runs in the app AFTER tombstone_staff_profile() commits, so it can fail or never run: a tombstone with auth_completed_at NULL is a HALF-FINISHED delete — re-send DELETE /api/staff/<id>/permanent, which re-runs only this step. Set once (NULL -> value), then frozen.';
COMMENT ON COLUMN public.profiles.auth_completed_at IS
  'STAFFDELETE.1 (mig 622): when the login step finished. Always set together with auth_disposition.';

-- Half-finished deletes, for an operator or a monitor:
--   SELECT id, full_name, deleted_at FROM public.profiles
--    WHERE deleted_at IS NOT NULL AND auth_completed_at IS NULL;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_tombstone_auth_step;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_tombstone_auth_step
  CHECK ((auth_disposition IS NULL AND auth_completed_at IS NULL)
      OR (deleted_at IS NOT NULL AND auth_completed_at IS NOT NULL
          AND auth_disposition IN ('ban', 'kept_member_login', 'kept_host_login')));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_tombstone_is_inactive;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_tombstone_is_inactive
  CHECK (deleted_at IS NULL OR (active IS FALSE AND deleted_role IS NOT NULL AND role = 'staff'));

CREATE INDEX IF NOT EXISTS idx_profiles_deleted_by
  ON public.profiles (deleted_by) WHERE deleted_by IS NOT NULL;

-- ─── anon / authenticated lose their WRITE grants on profiles ────────────────
-- Migs 153/153b revoked only SELECT ("Keep INSERT/UPDATE/DELETE alone"). So
-- both roles still hold table-level INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER (and column-level INSERT/UPDATE/REFERENCES) on
-- profiles, `profiles_update` allows `id = auth.uid()`, and nothing guards
-- `role` — a signed-in user is kept from `UPDATE profiles SET role='master'`
-- only by accident (no SELECT grant, so a filtered UPDATE fails; safeupdate
-- refuses an unfiltered one). That matters more now that role is what a
-- tombstone's safety rests on.
-- VERIFIED BEFORE ADDING THIS (2026-09-20): every write to profiles in src/
-- uses the service-role client — auth/set-pin (x3), admin/master-toggle (x2),
-- me/preferences, staff (POST), staff/[id] (x3), lib/staff-write — 11 sites;
-- shared/, mobile/ and champ-app never touch profiles; the only DB-side
-- writer reachable by a user action is handle_new_user(), SECURITY DEFINER.
-- A table-level REVOKE also removes the matching column-level grants
-- (PostgreSQL: "the corresponding column privileges are automatically revoked
-- on each column"), and SELECT — table or column — is not touched. Verified
-- against the catalog below, never against this text (the mig 153 lesson).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.profiles FROM anon, authenticated;

DO $$
DECLARE
  v_left integer;
BEGIN
  SELECT (SELECT count(*) FROM information_schema.table_privileges
           WHERE table_schema = 'public' AND table_name = 'profiles'
             AND grantee IN ('anon', 'authenticated') AND privilege_type <> 'SELECT')
       + (SELECT count(*) FROM information_schema.column_privileges
           WHERE table_schema = 'public' AND table_name = 'profiles'
             AND grantee IN ('anon', 'authenticated') AND privilege_type <> 'SELECT')
    INTO v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'mig 622: % write privilege(s) on public.profiles still held by anon/authenticated', v_left;
  END IF;
END $$;

-- ─── A tombstone is FROZEN ──────────────────────────────────────────────────
-- The CHECK above cannot stop an UN-delete: `SET deleted_at = NULL,
-- deleted_role = NULL, active = true` leaves a row that satisfies it (every
-- living row does). So once OLD.deleted_at is set, the columns that make the
-- row a tombstone — and the ones RLS or sign-in read — can never change.
-- tombstone_staff_profile() is unaffected: it writes them while OLD.deleted_at
-- IS NULL. auth_disposition / auth_completed_at are the one exemption: NULL ->
-- value, once. Other columns (updated_at, …) stay writable. No reads, so
-- SECURITY INVOKER is enough; `private` keeps it off the PostgREST surface.
CREATE OR REPLACE FUNCTION private.profiles_tombstone_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_col text;
BEGIN
  v_col := CASE
    WHEN NEW.deleted_at   IS DISTINCT FROM OLD.deleted_at   THEN 'deleted_at'
    WHEN NEW.deleted_by   IS DISTINCT FROM OLD.deleted_by   THEN 'deleted_by'
    WHEN NEW.deleted_role IS DISTINCT FROM OLD.deleted_role THEN 'deleted_role'
    WHEN NEW.role         IS DISTINCT FROM OLD.role         THEN 'role'
    WHEN NEW.active       IS DISTINCT FROM OLD.active       THEN 'active'
    WHEN NEW.email        IS DISTINCT FROM OLD.email        THEN 'email'
    WHEN NEW.permissions  IS DISTINCT FROM OLD.permissions  THEN 'permissions'
    -- The login step is recorded AFTER the tombstone exists, so these two —
    -- and ONLY these two — may go from NULL to a value, once.
    WHEN OLD.auth_disposition  IS NOT NULL AND NEW.auth_disposition  IS DISTINCT FROM OLD.auth_disposition  THEN 'auth_disposition'
    WHEN OLD.auth_completed_at IS NOT NULL AND NEW.auth_completed_at IS DISTINCT FROM OLD.auth_completed_at THEN 'auth_completed_at'
  END;
  IF v_col IS NOT NULL THEN
    RAISE EXCEPTION 'staff_tombstone_frozen: profile % was permanently deleted; % can no longer be changed', OLD.id, v_col;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.profiles_tombstone_frozen() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_tombstone_frozen ON public.profiles;
CREATE TRIGGER profiles_tombstone_frozen
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT NULL)
  EXECUTE FUNCTION private.profiles_tombstone_frozen();

-- ─── A tombstone can never be handed access again ──────────────────────────
-- RLS reads profile_locations (private.auth_is_in_location, auth_role, …) and
-- profile_organizations (private.auth_is_in_organization) LIVE, and three
-- routes write them by profile id (staff/[id]/org-admin, admin/assignments,
-- admin/assignments/bulk). The routes now refuse a tombstone; this makes the
-- DATABASE refuse it whichever path forgets to ask. DELETE is not guarded:
-- removing access is always allowed (and is what the function below does).
-- SECURITY DEFINER because `authenticated` holds no SELECT on profiles (mig
-- 153b) and the guard must still be able to read deleted_at for any writer;
-- it lives in `private` (not exposed by PostgREST), reads one boolean, and
-- pins search_path.
CREATE OR REPLACE FUNCTION private.refuse_tombstone_access_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.profile_id AND p.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'staff_tombstone_access: profile % was permanently deleted and cannot be given a role in %', NEW.profile_id, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.refuse_tombstone_access_row() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS refuse_tombstone_access_row ON public.profile_locations;
CREATE TRIGGER refuse_tombstone_access_row
  BEFORE INSERT OR UPDATE ON public.profile_locations
  FOR EACH ROW EXECUTE FUNCTION private.refuse_tombstone_access_row();

DROP TRIGGER IF EXISTS refuse_tombstone_access_row ON public.profile_organizations;
CREATE TRIGGER refuse_tombstone_access_row
  BEFORE INSERT OR UPDATE ON public.profile_organizations
  FOR EACH ROW EXECUTE FUNCTION private.refuse_tombstone_access_row();

-- ERRORS (all P0001; the message prefix is the contract the route maps):
--   staff_bad_args, staff_self_delete, staff_not_found, staff_still_active.
--   (An existing tombstone is NOT an error: the call returns
--   already_tombstoned = true and writes nothing.)
-- SECURITY: SECURITY INVOKER, search_path pinned empty, every name
-- schema-qualified, EXECUTE for service_role only (mig 496/612 posture).
CREATE OR REPLACE FUNCTION public.tombstone_staff_profile(
  p_profile_id uuid,
  p_actor_id   uuid,
  p_now        timestamptz DEFAULT now(),
  p_dry_run    boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_profile public.profiles;
  v_today   date;
  v_time    time;
  v_remove  uuid[];
  v_shifts  jsonb;
  v_today_kept jsonb;
  v_swaps   jsonb;
  v_leave   jsonb;
  v_kept    jsonb;
  v_deleted jsonb := '{}'::jsonb;
  v_pl_res  text[];
  v_n       integer;
  v_now     timestamptz := now();
  v_note    constant text := 'Cancelled automatically: staff member permanently deleted';
  v_floor   constant text := 'staff';  -- least-privileged role; see the header
BEGIN
  IF p_profile_id IS NULL OR p_actor_id IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'staff_bad_args: profile, actor and now are all required';
  END IF;
  -- ONE instant, read as the Dublin wall clock: the date and the time of day
  -- come from the same value, so they agree across midnight and DST changes.
  v_today := (p_now AT TIME ZONE 'Europe/Dublin')::date;
  v_time  := (p_now AT TIME ZONE 'Europe/Dublin')::time;
  IF p_profile_id = p_actor_id THEN
    RAISE EXCEPTION 'staff_self_delete: you cannot permanently delete your own account';
  END IF;

  -- 1. Lock the row and re-check the pre-flight inside the transaction.
  SELECT * INTO v_profile FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff_not_found: no profile %', p_profile_id;
  END IF;
  -- Already a tombstone: SAFE to call again. Say so and change nothing (a
  -- retry, a double click, or two masters at once must never re-run the
  -- removal against a later "now").
  IF v_profile.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('profile_id', p_profile_id, 'full_name', v_profile.full_name, 'dry_run', p_dry_run,
      'already_tombstoned', true, 'deleted_at', v_profile.deleted_at,
      'auth_disposition', v_profile.auth_disposition, 'auth_completed_at', v_profile.auth_completed_at,
      'removed_shifts', '[]'::jsonb, 'kept_today_shifts', '[]'::jsonb,
      'cancelled_swaps', '[]'::jsonb, 'cancelled_time_off', '[]'::jsonb,
      'role', jsonb_build_object('from', v_profile.deleted_role, 'to', v_profile.role),
      'deleted', '{}'::jsonb, 'kept', '{}'::jsonb);
  END IF;
  IF v_profile.active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'staff_still_active: deactivate the profile before deleting it';
  END IF;

  -- 2. What goes: assignments whose shift has NOT STARTED (any status). The id
  --    list is computed ONCE and drives the summary, the change log and the
  --    delete, so the three can never disagree. A NULL effective start cannot
  --    happen (shift_blocks.start_time is NOT NULL) but if it did the
  --    comparison is NULL: a shift dated today is then KEPT, one dated in the
  --    future is still removed.
  SELECT COALESCE(array_agg(a.id), ARRAY[]::uuid[])
    INTO v_remove
    FROM public.shift_assignments a
    JOIN public.shift_blocks b ON b.id = a.block_id
   WHERE a.profile_id = p_profile_id
     AND (b.block_date > v_today
          OR (b.block_date = v_today AND COALESCE(a.start_time_override, b.start_time) > v_time))
     -- ALREADY ARRIVED = HISTORY, whatever the clock says. A geofence arrival
     -- is matched up to 45 min BEFORE the start (GEOFENCE_EARLY_WINDOW_MS,
     -- src/lib/staff-attendance.js) and stamps arrived_at (mig 609); deleting
     -- that assignment would NULL staff_attendance_events.matched_assignment_id
     -- (mig 120:79) — a worked shift losing its attendance.
     AND a.arrived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.staff_attendance_events e WHERE e.matched_assignment_id = a.id);

  --    The summary shows LIVE ones, with the EFFECTIVE times the calendar shows.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'assignment_id', a.id, 'block_id', b.id, 'block_date', b.block_date,
           'start_time', COALESCE(a.start_time_override, b.start_time),
           'end_time',   COALESCE(a.end_time_override,   b.end_time),
           'template_name', t.name, 'location_id', b.location_id, 'location_name', l.name,
           'roster_status', r.status)
           ORDER BY b.block_date, COALESCE(a.start_time_override, b.start_time), a.id), '[]'::jsonb)
    INTO v_shifts
    FROM public.shift_assignments a
    JOIN public.shift_blocks b ON b.id = a.block_id
    LEFT JOIN public.rosters r ON r.id = b.roster_id
    LEFT JOIN public.shift_templates t ON t.id = b.template_id
    LEFT JOIN public.locations l ON l.id = b.location_id
   WHERE a.id = ANY (v_remove)
     AND a.status IS DISTINCT FROM 'cancelled';

  --    Kept although dated today or later: shifts that HAVE started (in
  --    progress, finished, or starting exactly now — reason 'started'), and
  --    not-started shifts the person has already arrived for (reason
  --    'arrived'). History. Reported so the dialog can say they are kept.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'reason', CASE WHEN b.block_date > v_today
                            OR COALESCE(a.start_time_override, b.start_time) > v_time
                          THEN 'arrived' ELSE 'started' END,
           'assignment_id', a.id, 'block_id', b.id, 'block_date', b.block_date,
           'start_time', COALESCE(a.start_time_override, b.start_time),
           'end_time',   COALESCE(a.end_time_override,   b.end_time),
           'template_name', t.name, 'location_id', b.location_id, 'location_name', l.name,
           'roster_status', r.status)
           ORDER BY b.block_date, COALESCE(a.start_time_override, b.start_time), a.id), '[]'::jsonb)
    INTO v_today_kept
    FROM public.shift_assignments a
    JOIN public.shift_blocks b ON b.id = a.block_id
    LEFT JOIN public.rosters r ON r.id = b.roster_id
    LEFT JOIN public.shift_templates t ON t.id = b.template_id
    LEFT JOIN public.locations l ON l.id = b.location_id
   WHERE a.profile_id = p_profile_id
     AND b.block_date >= v_today
     AND NOT (a.id = ANY (v_remove))
     AND a.status IS DISTINCT FROM 'cancelled';

  --    Open swaps are keyed on STATUS, not date: a pending swap can no longer
  --    happen whichever shift it names, so every open one is cancelled.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id, 'location_id', s.location_id, 'requester_id', s.requester_id,
           'target_id', s.target_id, 'status', s.status) ORDER BY s.id), '[]'::jsonb)
    INTO v_swaps
    FROM public.shift_swap_requests s
   WHERE s.status IN ('pending', 'awaiting_approval')
     AND (s.requester_id = p_profile_id OR s.target_id = p_profile_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', o.id, 'type', o.type, 'start_date', o.start_date, 'end_date', o.end_date) ORDER BY o.start_date, o.id), '[]'::jsonb)
    INTO v_leave
    FROM public.time_off_requests o
   WHERE o.profile_id = p_profile_id AND o.status = 'pending' AND o.end_date >= v_today;

  -- 3. What stays — counted so the caller can PROVE history did not move.
  v_kept := jsonb_build_object(
    -- every assignment that is NOT being removed: before today, or today and started.
    'past_shifts', (SELECT count(*) FROM public.shift_assignments a
                     WHERE a.profile_id = p_profile_id AND NOT (a.id = ANY (v_remove))),
    'time_off_requests',      (SELECT count(*) FROM public.time_off_requests      WHERE profile_id = p_profile_id),
    'staff_allowances',       (SELECT count(*) FROM public.staff_allowances       WHERE profile_id = p_profile_id),
    'contractor_invoices',    (SELECT count(*) FROM public.contractor_invoices    WHERE contractor_id = p_profile_id),
    'schedule_notifications', (SELECT count(*) FROM public.schedule_notifications WHERE profile_id = p_profile_id));

  IF p_dry_run THEN
    RETURN jsonb_build_object('profile_id', p_profile_id, 'full_name', v_profile.full_name, 'dry_run', true,
      'removed_shifts', v_shifts, 'kept_today_shifts', v_today_kept,
      'cancelled_swaps', v_swaps, 'cancelled_time_off', v_leave,
      'role', jsonb_build_object('from', v_profile.role, 'to', v_floor),
      'deleted', v_deleted, 'kept', v_kept);
  END IF;

  -- 4. Not-started shifts. One change-log row per PUBLISHED removal (draft edits
  --    are never logged — SCHEDULE-CHANGE-LOG.1). notified_at is stamped: the
  --    re-publish safety net re-notifies the coach of any unstamped row, and
  --    this coach is gone.
  INSERT INTO public.roster_change_log (location_id, block_id, block_date, actor_id, coach_id, action, details, notified_at)
  SELECT (x->>'location_id')::uuid, (x->>'block_id')::uuid, (x->>'block_date')::date,
         p_actor_id, p_profile_id, 'unassigned', jsonb_build_object('reason', 'staff_permanent_delete'), v_now
    FROM jsonb_array_elements(v_shifts) AS x
   WHERE x->>'roster_status' = 'published' AND (x->>'location_id') IS NOT NULL;

  --    Swap history survives this delete: both shift pointers on
  --    shift_swap_requests are ON DELETE SET NULL since mig 603.
  --    Deletes EXACTLY the ids computed in step 2 — never by date alone, so a
  --    started shift cannot be caught by this statement.
  DELETE FROM public.shift_assignments a
   WHERE a.id = ANY (v_remove) AND a.profile_id = p_profile_id;

  -- 5. Open swaps they are on either side of.
  UPDATE public.shift_swap_requests
     SET status = 'cancelled', reviewed_by = p_actor_id, reviewed_at = v_now, updated_at = v_now,
         review_note = CASE WHEN COALESCE(review_note, '') = '' THEN v_note ELSE review_note || ' · ' || v_note END
   WHERE status IN ('pending', 'awaiting_approval')
     AND (requester_id = p_profile_id OR target_id = p_profile_id);

  -- 6. Pending leave that is still ahead. pending -> cancelled never touches
  --    the allowance (the mig 011/616 trigger only reacts to 'approved').
  UPDATE public.time_off_requests
     SET status = 'cancelled', updated_at = v_now,
         review_note = CASE WHEN COALESCE(review_note, '') = '' THEN v_note ELSE review_note || ' · ' || v_note END
   WHERE profile_id = p_profile_id AND status = 'pending' AND end_date >= v_today;

  -- 7. Access rows and tokens. profile_locations ids are remembered first:
  --    the mig 191 audit trigger logs each delete under that resource name.
  SELECT COALESCE(array_agg('profile_locations/' || pl.id::text), ARRAY[]::text[])
    INTO v_pl_res FROM public.profile_locations pl WHERE pl.profile_id = p_profile_id;

  DELETE FROM public.profile_locations WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('profile_locations', v_n);
  DELETE FROM public.profile_organizations WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('profile_organizations', v_n);
  DELETE FROM public.device_tokens WHERE user_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('device_tokens', v_n);
  DELETE FROM public.widget_tokens WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('widget_tokens', v_n);
  DELETE FROM public.email_mailbox_access WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('email_mailbox_access', v_n);
  DELETE FROM public.mobile_bar_prefs WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('mobile_bar_prefs', v_n);

  -- 8. The tombstone. KEPT on purpose: full_name, employment_type,
  --    created_at, and the pay columns (+ the profile_compensation row, which
  --    is not touched) — staff_cost and the week-cost panels cost PAST shifts
  --    from the person's rate; clearing it would rewrite history as EUR 0.
  --    ROLE: remembered in deleted_role, then demoted to the floor. RLS reads
  --    profiles.role live, so this takes a deleted master's RLS powers away at
  --    once — for an unexpired access token, a login we kept, and a failed ban
  --    alike. (mig 080's guard_at_least_one_master sees master -> staff as a
  --    demotion and refuses it if no OTHER active master exists; the actor is
  --    one, so it passes — and if it ever does not, everything rolls back.)
  UPDATE public.profiles
     SET deleted_role = v_profile.role,
         role = v_floor,
         email = 'deleted+' || p_profile_id::text || '@deleted.invalid',
         avatar_url = NULL,
         permissions = '{}'::jsonb,
         two_factor_enabled = false,
         pin_hash = NULL, pin_set_at = NULL, pin_failed_count = 0, pin_locked_until = NULL,
         home_screen_path = '/dashboard',
         unifi_door_access = false, unifi_user_id = NULL,
         email_signature = NULL, email_signature_rich = NULL,
         deleted_at = v_now, deleted_by = p_actor_id, updated_at = v_now
   WHERE id = p_profile_id;

  -- 9. Redact what auditing captured. The mig 191 trigger has just written the
  --    OLD email / pin_hash / door ids into audit_events.details for the rows
  --    above; older rows carry "Name <email>" labels and sign-in emails. The
  --    rows stay (who did what, when) — the values go.
  UPDATE public.audit_events
     SET details = jsonb_build_object('redacted', 'staff_permanent_delete')
   WHERE category = 'mutation'
     AND (target_resource = 'profiles/' || p_profile_id::text OR target_resource = ANY (v_pl_res));
  UPDATE public.audit_events SET actor_label = v_profile.full_name
   WHERE actor_id = p_profile_id AND actor_label IS NOT NULL AND actor_label IS DISTINCT FROM v_profile.full_name;
  UPDATE public.audit_events SET target_label = v_profile.full_name
   WHERE target_profile_id = p_profile_id AND target_label IS NOT NULL AND target_label IS DISTINCT FROM v_profile.full_name;
  UPDATE public.audit_events SET details = details - 'email'
   WHERE category = 'auth' AND (actor_id = p_profile_id OR target_profile_id = p_profile_id) AND details ? 'email';

  RETURN jsonb_build_object('profile_id', p_profile_id, 'full_name', v_profile.full_name, 'dry_run', false,
    'removed_shifts', v_shifts, 'kept_today_shifts', v_today_kept,
    'cancelled_swaps', v_swaps, 'cancelled_time_off', v_leave,
    'role', jsonb_build_object('from', v_profile.role, 'to', v_floor),
    'deleted', v_deleted, 'kept', v_kept);
END;
$$;

COMMENT ON FUNCTION public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean) IS
  'STAFFDELETE.1 (mig 622) — permanent delete that keeps history. One transaction: removes NOT-STARTED assignments (logging published ones), cancels open swaps and still-ahead pending leave, deletes access rows/tokens, strips PII from the profile but keeps full_name/pay, copies role into deleted_role and demotes role to staff (RLS reads role live), redacts audit payloads. "Upcoming" = NOT STARTED on the Europe/Dublin wall clock of p_now; a shift that has started today is history and stays. p_dry_run returns the same summary and writes nothing. Never deletes from profiles. Errors are P0001 with a staff_* prefix. service_role only.';

REVOKE ALL ON FUNCTION public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean) TO service_role;
