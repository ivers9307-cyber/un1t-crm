-- 630 — AVAIL.1: coach availability. A coach declares when they CANNOT work;
-- everything else is available. No approval. Managers are told of a change.
--
-- THE MODEL (Richard's decisions + plan index defaults 1 and 2)
-- ─────────────────────────────────────────────────────────────
--   * Per PERSON, not per studio: a coach at both studios declares once.
--   * UNAVAILABLE windows, two kinds, one table:
--       weekly  weekday ('mon'..'sun', the shift_templates.days_of_week codes,
--               mig 067) + a time window or the whole day;
--       dated   start_date..end_date (at most 366 days) + a time window or
--               the whole day, optional note.
--     No overnight windows: end_time > start_time on the same day.
--   * A save REPLACES the person's weekly rules and their dated rules that
--     have not ended (end_date >= the caller's Dublin today). A dated rule
--     that ended before today is history: kept, never replaced, never added.
--     A dated rule may not START before today unless it is one the person
--     already has with the same dates and window (no backdating).
--     A started rule that a save deletes or cuts short keeps its elapsed days
--     (start_date..yesterday) as a history row: what was declared for a day
--     that has gone is never rewritten.
--   * Every real change writes ONE staff_availability_changes row (before and
--     after snapshots, the actor). That row is also the notice queue: the
--     route tells the managers at once inside 07:00-22:00 studio time, and
--     the checklist-sweep cron's availability arm tells them at 07:00 for a
--     save made outside it, then stamps notified_at + notice_outcome.
--
-- POSTURE: SERVICE ROLE ONLY. RLS is enabled with NO policies and the browser
-- roles hold NO privilege on either table or on the RPC. Every reader is an
-- /api route on the service-role client (the phone included, with its Bearer
-- token), so a policy here would be surface nobody calls. This is the posture
-- of the ~47 tables get_advisors lists as rls_enabled_no_policy (INFO);
-- expect that count to rise by exactly 2.
--
-- FKs: profile_id CASCADE, actor_id SET NULL. Both are inert: a staff profile
-- is never deleted (mig 622 tombstones it). CASCADE for the rules because a
-- rule about a person who no longer exists has no history value; SET NULL for
-- the actor because an audit row must outlive its actor (roster_change_log,
-- mig 236, does the same).
--
-- PERMANENT DELETE: public.tombstone_staff_profile() (mig 622) is NOT changed
-- here, on purpose (owner's call, 25 Sep). A tombstoned person's rules and
-- notes stay on disk but stop mattering: a tombstone has no profile_locations,
-- so the manager range read never lists them and they can never be rostered;
-- and the RPC refuses a tombstoned profile (availability_no_profile). Whether
-- the function should also delete the rules / null the notes is a follow-up.
--
-- WHY AN RPC FOR THE SAVE: "delete my current rules, insert the new set, log
-- it" as two PostgREST calls loses a coach's whole availability if the second
-- fails. The function does it in one transaction under a per-person advisory
-- lock, and returns changed=false WITHOUT WRITING when the new set equals the
-- current one, so a repeated Save neither logs nor notifies anyone.
-- SECURITY INVOKER, search_path '', every name schema-qualified; EXECUTE for
-- service_role only (the mig 612 posture). Errors the route maps to 400: any
-- 'availability_*' P0001 message, 23514 (CHECK), 22007/22008/22P02/22023
-- (unparseable input).
--
-- NOT APPLIED BY THE PR. Apply BEFORE the AVAIL.1a code deploys (safe alone:
-- new objects only; nothing reads them until the code lands).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; keep the output in the scratchpad)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) Nothing by these names exists yet:
--       SELECT to_regclass('public.staff_unavailability'), to_regclass('public.staff_availability_changes'),
--              to_regprocedure('public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb)');
--     Expected: NULL, NULL, NULL.
-- (b) SELECT name FROM public.cron_heartbeats WHERE name = 'availability-notice-sweep';   -- 0 rows
-- (c) The columns the RPC reads exist:
--       SELECT column_name FROM information_schema.columns
--        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name IN ('id', 'deleted_at');  -- 2 rows
-- (d) The advisor baseline: get_advisors(security) → rls_enabled_no_policy count (47 on 25 Sep).
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (e) SELECT r, t, p FROM unnest(ARRAY['anon', 'authenticated']) r,
--            unnest(ARRAY['public.staff_unavailability', 'public.staff_availability_changes']) t,
--            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
--      WHERE has_table_privilege(r, t, p);
--     Expected: 0 rows.
-- (f) SELECT has_function_privilege('authenticated', 'public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb)', 'EXECUTE'),
--            has_function_privilege('service_role',  'public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb)', 'EXECUTE');
--     Expected: false, true.
-- (g) SELECT name, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats
--      WHERE name = 'availability-notice-sweep';   -- 900, 1800
-- (h) get_advisors (security AND performance). Expected: rls_enabled_no_policy
--     +2 (these two tables), nothing else new. unindexed_foreign_keys: none
--     (all three FKs are indexed below).
-- (i) Smoke once deployed:
--       PUT /api/schedule/availability {"weekly":[],"dated":[]} as yourself → 200 { changed: false }.
--
-- ROLLBACK (only before any coach has saved; afterwards, dump both tables
-- first):
--   DROP FUNCTION IF EXISTS public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb);
--   DROP TABLE IF EXISTS public.staff_availability_changes;
--   DROP TABLE IF EXISTS public.staff_unavailability;
--   DELETE FROM public.cron_heartbeats WHERE name = 'availability-notice-sweep';
-- and revert the AVAIL.1a code in the same hour (its routes 500 without them).

BEGIN;

-- ── The rules ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_unavailability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  weekday     text,
  start_date  date,
  end_date    date,
  all_day     boolean NOT NULL DEFAULT false,
  start_time  time,
  end_time    time,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_unavailability_kind CHECK (kind IN ('weekly', 'dated')),
  CONSTRAINT staff_unavailability_weekday CHECK (
    weekday IS NULL OR weekday IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
  ),
  CONSTRAINT staff_unavailability_kind_shape CHECK (
    (kind = 'weekly' AND weekday IS NOT NULL AND start_date IS NULL AND end_date IS NULL)
    OR (kind = 'dated' AND weekday IS NULL AND start_date IS NOT NULL AND end_date IS NOT NULL
        AND end_date >= start_date AND end_date - start_date <= 365)
  ),
  CONSTRAINT staff_unavailability_window CHECK (
    (all_day AND start_time IS NULL AND end_time IS NULL)
    OR (NOT all_day AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  ),
  CONSTRAINT staff_unavailability_note CHECK (note IS NULL OR char_length(note) <= 200)
);

-- Serves every read and the RPC's replace: "this person's weekly rules, and
-- their dated rules ending on or after a date" (and the manager range read's
-- profile_id IN (...)). Leads with profile_id, so it also covers the FK.
CREATE INDEX IF NOT EXISTS staff_unavailability_profile_kind_end_idx
  ON public.staff_unavailability (profile_id, kind, end_date);

ALTER TABLE public.staff_unavailability ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_unavailability FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_unavailability TO service_role;

COMMENT ON TABLE public.staff_unavailability IS
  'AVAIL.1 (mig 630) — when a coach CANNOT work, per person. kind weekly = weekday (mon..sun, shift_templates.days_of_week codes) + a window or all day; kind dated = start_date..end_date (<= 366 days) + a window or all day, optional note (managers see it). Everything else is available. Written ONLY by public.replace_staff_unavailability (service role); dated rules that ended before the saver''s Dublin today are history and are never replaced. Service-role only: RLS on, no policies, no browser grants.';

-- ── The audit / notice queue ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_availability_changes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  before         jsonb NOT NULL DEFAULT '[]'::jsonb,
  after          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  notified_at    timestamptz,
  notice_outcome text,
  CONSTRAINT staff_availability_changes_notice_outcome CHECK (
    notice_outcome IS NULL OR notice_outcome IN ('sent', 'no_recipients', 'stale', 'reverted')
  ),
  CONSTRAINT staff_availability_changes_notice_pair CHECK ((notified_at IS NULL) = (notice_outcome IS NULL))
);

-- A person's history, newest first (also covers the profile_id FK).
CREATE INDEX IF NOT EXISTS staff_availability_changes_profile_created_idx
  ON public.staff_availability_changes (profile_id, created_at DESC);
-- The cron arm's read: notices still owed, oldest first.
CREATE INDEX IF NOT EXISTS staff_availability_changes_unnotified_idx
  ON public.staff_availability_changes (created_at)
  WHERE notified_at IS NULL;
-- Covers the actor_id FK (advisor unindexed_foreign_keys).
CREATE INDEX IF NOT EXISTS staff_availability_changes_actor_idx
  ON public.staff_availability_changes (actor_id)
  WHERE actor_id IS NOT NULL;

ALTER TABLE public.staff_availability_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_availability_changes FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_availability_changes TO service_role;

COMMENT ON TABLE public.staff_availability_changes IS
  'AVAIL.1 (mig 630) — one row per real change to a coach''s availability (the RPC writes none for a no-op save): before/after snapshots of the weekly + current/future dated rules, actor_id (the master under View as user). Also the notice queue: notified_at NULL = the managers are still owed a push (sent at once inside 07:00-22:00 studio time, else by the checklist-sweep cron''s availability arm); notice_outcome says how it ended (sent | no_recipients | stale after 24h | reverted when later saves undid it). Service-role only.';

-- ── The save ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replace_staff_unavailability(
  p_profile_id uuid,
  p_actor_id   uuid,
  p_today      date,
  p_weekly     jsonb,
  p_dated      jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_before    jsonb;
  v_after     jsonb;
  v_change_id uuid;
BEGIN
  IF p_profile_id IS NULL OR p_today IS NULL THEN
    RAISE EXCEPTION 'availability_bad_args: a profile and today are required';
  END IF;
  IF jsonb_typeof(COALESCE(p_weekly, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_dated, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'availability_bad_args: weekly and dated must be arrays';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_profile_id AND p.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'availability_no_profile: % is not a current staff profile', p_profile_id;
  END IF;

  -- One save per person at a time: a double-clicked Save, or the phone and
  -- the web at once, queue here instead of interleaving delete and insert.
  PERFORM pg_advisory_xact_lock(hashtextextended('staff_unavailability:' || p_profile_id::text, 0));

  -- The CURRENT set, in canonical form. The SAME columns, types and ORDER BY
  -- as v_after below: the two are compared as jsonb, so they must be built
  -- the same way.
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.kind, r.weekday, r.start_date, r.end_date,
                                                 r.all_day, r.start_time, r.end_time, r.note), '[]'::jsonb)
    INTO v_before
    FROM (
      SELECT u.kind, u.weekday, u.start_date, u.end_date, u.all_day,
             left(u.start_time::text, 5) AS start_time,
             left(u.end_time::text, 5)   AS end_time,
             u.note
        FROM public.staff_unavailability u
       WHERE u.profile_id = p_profile_id
         AND (u.kind = 'weekly' OR u.end_date >= p_today)
    ) r;

  -- The NEW set, canonical: all_day drops any times, a blank note is NULL,
  -- a dated rule with no end_date is one day, identical rules collapse.
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.kind, r.weekday, r.start_date, r.end_date,
                                                 r.all_day, r.start_time, r.end_time, r.note), '[]'::jsonb)
    INTO v_after
    FROM (
      SELECT DISTINCT
             i.kind, i.weekday, i.start_date, i.end_date, i.all_day,
             CASE WHEN i.all_day THEN NULL ELSE left(i.start_time::text, 5) END AS start_time,
             CASE WHEN i.all_day THEN NULL ELSE left(i.end_time::text, 5)   END AS end_time,
             i.note
        FROM (
          SELECT 'weekly'::text                              AS kind,
                 lower(btrim(e->>'weekday'))                 AS weekday,
                 NULL::date                                  AS start_date,
                 NULL::date                                  AS end_date,
                 COALESCE((e->>'all_day')::boolean, false)   AS all_day,
                 (e->>'start_time')::time                    AS start_time,
                 (e->>'end_time')::time                      AS end_time,
                 NULLIF(btrim(e->>'note'), '')               AS note
            FROM jsonb_array_elements(COALESCE(p_weekly, '[]'::jsonb)) e
          UNION ALL
          SELECT 'dated'::text,
                 NULL::text,
                 (e->>'start_date')::date,
                 COALESCE((e->>'end_date')::date, (e->>'start_date')::date),
                 COALESCE((e->>'all_day')::boolean, false),
                 (e->>'start_time')::time,
                 (e->>'end_time')::time,
                 NULLIF(btrim(e->>'note'), '')
            FROM jsonb_array_elements(COALESCE(p_dated, '[]'::jsonb)) e
        ) i
    ) r;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_after) AS x(kind text, end_date date)
     WHERE x.kind = 'dated' AND x.end_date < p_today
  ) THEN
    RAISE EXCEPTION 'availability_past_date: a date that has already passed cannot be added';
  END IF;

  -- No backdating: a dated rule that starts before today must be one the
  -- person already has, current (end_date >= today), with the same content
  -- (dates, all_day, times; the note may change). A new or changed one would
  -- claim days that are already gone.
  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(v_after) AS x(kind text, start_date date, end_date date,
                                            all_day boolean, start_time time, end_time time)
     WHERE x.kind = 'dated' AND x.start_date < p_today
       AND NOT EXISTS (
         SELECT 1 FROM public.staff_unavailability u
          WHERE u.profile_id = p_profile_id AND u.kind = 'dated' AND u.end_date >= p_today
            AND u.start_date = x.start_date AND u.end_date = x.end_date AND u.all_day = x.all_day
            AND u.start_time IS NOT DISTINCT FROM x.start_time
            AND u.end_time IS NOT DISTINCT FROM x.end_time)
  ) THEN
    RAISE EXCEPTION 'availability_past_start: a new date cannot start before today';
  END IF;

  IF v_after = v_before THEN
    RETURN jsonb_build_object('changed', false, 'change_id', NULL, 'before', v_before, 'after', v_after);
  END IF;

  -- The days already gone are history. A dated rule that has STARTED
  -- (start_date < today <= end_date) and is not kept as it is (same dates and
  -- window; a note edit keeps it whole) is deleted or cut short by this save:
  -- first keep its elapsed part, start_date..yesterday, as a row of its own.
  -- It ends before today, so the DELETE below never touches it.
  INSERT INTO public.staff_unavailability
         (profile_id, kind, start_date, end_date, all_day, start_time, end_time, note)
  SELECT u.profile_id, 'dated', u.start_date, p_today - 1, u.all_day, u.start_time, u.end_time, u.note
    FROM public.staff_unavailability u
   WHERE u.profile_id = p_profile_id
     AND u.kind = 'dated'
     AND u.start_date < p_today
     AND u.end_date >= p_today
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_after) AS x(kind text, start_date date, end_date date,
                                               all_day boolean, start_time time, end_time time)
        WHERE x.kind = 'dated'
          AND x.start_date = u.start_date AND x.end_date = u.end_date AND x.all_day = u.all_day
          AND x.start_time IS NOT DISTINCT FROM u.start_time
          AND x.end_time IS NOT DISTINCT FROM u.end_time);

  DELETE FROM public.staff_unavailability u
   WHERE u.profile_id = p_profile_id
     AND (u.kind = 'weekly' OR u.end_date >= p_today);

  -- The CHECKs on the table judge every row here: one bad rule aborts the
  -- whole transaction and the old set survives untouched.
  INSERT INTO public.staff_unavailability
         (profile_id, kind, weekday, start_date, end_date, all_day, start_time, end_time, note)
  SELECT p_profile_id, x.kind, x.weekday, x.start_date, x.end_date, x.all_day, x.start_time, x.end_time, x.note
    FROM jsonb_to_recordset(v_after) AS x(kind text, weekday text, start_date date, end_date date,
                                          all_day boolean, start_time time, end_time time, note text);

  INSERT INTO public.staff_availability_changes (profile_id, actor_id, before, after)
  VALUES (p_profile_id, p_actor_id, v_before, v_after)
  RETURNING id INTO v_change_id;

  RETURN jsonb_build_object('changed', true, 'change_id', v_change_id, 'before', v_before, 'after', v_after);
END;
$$;

COMMENT ON FUNCTION public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb) IS
  'AVAIL.1 (mig 630) — replaces a coach''s weekly rules and their dated rules ending on/after p_today with p_weekly/p_dated, atomically, and logs ONE staff_availability_changes row. Returns { changed, change_id, before, after } (canonical snapshots); changed=false writes nothing. Refuses a dated rule ending before p_today (availability_past_date), a new or changed dated rule starting before p_today (availability_past_start), a tombstoned or unknown profile (availability_no_profile), non-array input (availability_bad_args); the table CHECKs refuse malformed rules (23514). service_role only.';

REVOKE ALL ON FUNCTION public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb) TO service_role;

-- ── The cron arm's heartbeat (the SWAPHB.1 lesson, mig 623) ──────────────
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'availability-notice-sweep',
  now(),
  900,
  1800,
  'AVAIL.1 — the availability-notice arm (src/lib/availability-notify.js runAvailabilityNoticeSweep) of the */15 Vercel cron /api/cron/checklist-sweep; no route or vercel.json entry of its own. It pushes the managers about availability saves made outside 07:00-22:00 studio time (and any in-band save whose immediate push did not land). Stamped ONLY when the arm ran and reported errors: 0; quiet-hours ticks stamp. STALE = the arm threw or reported errors on every tick for 45 minutes: read last_outcome.availability_notices on the checklist-sweep row and the availability-notify logError lines.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- ── Self-check against the catalog, never this text (the mig 153 lesson) ──
DO $$
DECLARE
  v_role text;
  v_priv text;
  v_n    int;
  v_fn   text := 'public.replace_staff_unavailability(uuid, uuid, date, jsonb, jsonb)';
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.staff_unavailability', v_priv)
         OR has_table_privilege(v_role, 'public.staff_availability_changes', v_priv) THEN
        RAISE EXCEPTION 'mig 630: % still holds % on an availability table', v_role, v_priv;
      END IF;
    END LOOP;
    IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 630: % can execute replace_staff_unavailability', v_role;
    END IF;
  END LOOP;

  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.staff_unavailability', v_priv)
       OR NOT has_table_privilege('service_role', 'public.staff_availability_changes', v_priv) THEN
      RAISE EXCEPTION 'mig 630: service_role lacks % on an availability table', v_priv;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 630: service_role cannot execute replace_staff_unavailability';
  END IF;

  SELECT count(*) INTO v_n FROM pg_class
   WHERE oid IN ('public.staff_unavailability'::regclass, 'public.staff_availability_changes'::regclass)
     AND relrowsecurity;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'mig 630: RLS is not enabled on both availability tables';
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('staff_unavailability', 'staff_availability_changes');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'mig 630: expected no policies on the availability tables, found %', v_n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.cron_heartbeats WHERE name = 'availability-notice-sweep') THEN
    RAISE EXCEPTION 'mig 630: the availability-notice-sweep heartbeat row is missing';
  END IF;
END $$;

COMMIT;
