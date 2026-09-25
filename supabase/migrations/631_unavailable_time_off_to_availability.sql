-- 631 — AVAIL.3: contractors' "unavailable" time off moves into availability.
--
-- 🔴 APPLYING THIS FILE MOVES NOTHING. It installs the ledger and the two
-- functions only. THE DATA MOVE IS HELD FOR THE OWNER'S EXPLICIT GO and is a
-- separate operator step that CALLS the move function:
--
--     supabase/operator-scripts/631_run_move_unavailable_time_off.sql
--     (one statement: SELECT public.move_unavailable_time_off_to_availability(
--                       (now() AT TIME ZONE 'Europe/Dublin')::date) AS result;)
--
-- Nothing in this file calls it, and tests/migration-631-…test.js pins that.
--
-- WHAT THE MOVE DOES (when the operator runs it)
-- ──────────────────────────────────────────────
-- Coaches used to say "I can't work 3-5 Oct" by filing a time_off_requests
-- row of type 'unavailable' that a manager approved (contractors and casual
-- staff had no other type). AVAIL.1 (mig 630) made that self-declared: a
-- staff_unavailability rule, no approval, managers told. The AVAIL.3 code
-- (deployed BEFORE the move runs) stops offering and accepting the type. The
-- move carries every current one across:
--
--   CARRY SET  type = 'unavailable', status approved OR pending,
--              end_date >= today (Dublin, taken once when the move runs), and the
--              person is not tombstoned (profiles.deleted_at IS NULL).
--              Rejected / cancelled rows, rows that ended, other types and a
--              tombstone's rows are NOT touched.
--   FUTURE     (start_date >= today) the row is DELETED from time_off_requests
--              after its full row is copied into the ledger.
--   STARTED    (start_date < today) the row is SPLIT: it keeps
--              start_date..yesterday as time off (total_days trimmed to the
--              elapsed days); today..end_date moves. The days already gone
--              stay history, and no day is ever in both places.
--   RULE       kind 'dated', all day, greatest(start_date, today)..end_date,
--              note = the reason trimmed as JS .trim() trims it (every
--              Unicode space and line break, not only ' '; blank -> NULL). One rule per
--              distinct (person, start, end); an identical all-day rule the
--              person already has is reused. The earliest request's note wins
--              a collapse; every other note stays in the ledger's copy.
--
-- WHAT IT MUST NOT DO, AND WHY IT CAN'T
-- ─────────────────────────────────────
--   * Notify anyone. It writes staff_unavailability directly, never through
--     replace_staff_unavailability, and writes NO staff_availability_changes
--     row. The AVAIL.1a notice path (route + checklist-sweep arm) only reads
--     change rows with notified_at IS NULL, so nothing is owed or sent.
--   * Move a leave balance or pay. The one trigger on time_off_requests is
--     trg_update_holiday_allowance, AFTER UPDATE, and both branches of its
--     function (mig 616) test NEW.type = 'holiday'. The split UPDATE touches
--     'unavailable' rows only; DELETE fires nothing. Payroll and contractor
--     invoices do not read time_off_requests.
--   * Lose a day. The move function checks, before it returns, that every
--     carried (person, day) is covered by an all-day dated rule and that
--     every split row still starts where it did and ends yesterday; any miss
--     raises and the whole transaction rolls back.
--
-- THE LEDGER (time_off_availability_moves) is the audit AND the rollback
-- record: one row per time_off_requests row touched, the FULL original row
-- (to_jsonb), the rule it became, whether that rule was inserted or reused.
-- Service-role only (RLS on, no policies, no browser grants), like mig 630.
-- No FKs on purpose: it must outlive anything it points at.
--
-- TWO FUNCTIONS, installed by this file (service_role only):
--   move_unavailable_time_off_to_availability(p_today date) -> jsonb
--     THE MOVE (run by the operator script, never by this file). Re-runnable:
--     carries anything eligible that is not in the ledger yet (a straggler
--     filed before the code deployed). Idempotent.
--   restore_moved_unavailable_time_off(p_batch_id uuid DEFAULT NULL) -> jsonb
--     THE ROLLBACK: re-inserts every moved row byte-for-byte (same id; a
--     column ADDED to time_off_requests since takes its default; a saved
--     column since DROPPED refuses the whole restore, avail3_restore_shape),
--     re-extends every split row, deletes each carried rule the person has
--     not changed since (a changed one is left and reported as
--     restored_rule_changed). Rules are keyed by (person, start, end): one a
--     LATER batch reused is kept until that batch is restored too
--     (restored_rule_in_use), so restoring one batch never strands another
--     batch's days. Idempotent. A restored row stays remembered by
--     the ledger, so a later move leaves it alone; to move it again, an
--     operator deletes its ledger row first, AS THE TABLE OWNER (postgres,
--     the Supabase MCP role): service_role holds no DELETE on the ledger.
--
-- GUARDS (any one aborts the whole move, nothing half-moved):
--   avail3_open_cancel_ask  a carry row has a cancellation ask no owner has
--                           decided (decide it first, then re-run the move)
--   avail3_note_too_long    a trimmed reason over 200 UTF-16 units (the
--                           editor's count; stricter than mig 630's
--                           character CHECK); never silently truncated
--   avail3_too_far_ahead    a rule starting more than 730 days ahead
--                           (AVAILABILITY_LIMITS.aheadDays: the coach's next
--                           save would be refused)
--   avail3_too_many_dates   more than 60 current dated rules for one person
--                           (AVAILABILITY_LIMITS.dated: same reason)
--   avail3_fk_into_time_off a foreign key references time_off_requests (a
--                           moved row is DELETED; checked before anything)
-- All five were 0 on 25 Sep.
--
-- ORDER: (1) the AVAIL.3 code deploys (the POST then refuses the type, so
-- nothing can be filed behind the move); (2) this file is applied (installs
-- only, safe at any hour); (3) ON THE OWNER'S GO, pre-checks (b)-(h), then the
-- operator script, then post-checks (i)-(q). Run the MOVE not within 15
-- minutes of Dublin midnight ("today" is taken once, when it runs). On 25 Sep
-- the carry set was 11 rows / 5 people (9 moved, 2 split, 0 pending); it is
-- computed live.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-CHECKS (read-only; (a) before applying this file, (b)-(h) right before
-- the MOVE; save ALL output to the scratchpad as the rollback record:
-- mig631-rollback-<date>.txt)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The names are free:
--       SELECT to_regclass('public.time_off_availability_moves'),
--              to_regprocedure('public.move_unavailable_time_off_to_availability(date)'),
--              to_regprocedure('public.restore_moved_unavailable_time_off(uuid)');
--     Expected: NULL, NULL, NULL.
-- (b) The AVAIL.3 code is live: the Vercel production deployment of the merge
--     commit is READY (Vercel MCP list_deployments). Optional proof, safe
--     because the refusal happens before any read or write: from a signed-in
--     crm.repset.ie tab, POST /api/schedule/time-off
--     {"type":"unavailable","start_date":"<tomorrow>","end_date":"<tomorrow>"}
--     answers 400 "Unavailable is no longer a time-off request…".
--     And no foreign key points INTO time_off_requests (see (g); 0 rows).
-- (c) THE CARRY SET, row by row (ids and shapes only, no names):
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d)
--       SELECT r.id, r.profile_id, r.location_id, r.status, r.start_date, r.end_date, r.total_days,
--              char_length(r.reason) AS reason_chars,
--              (r.cancel_requested_at IS NOT NULL AND r.cancel_decided_at IS NULL) AS open_cancel_ask,
--              CASE WHEN r.start_date < t.d THEN 'split' ELSE 'moved' END AS action
--         FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t
--        WHERE r.type = 'unavailable' AND r.status IN ('approved', 'pending')
--          AND r.end_date >= t.d AND p.deleted_at IS NULL
--        ORDER BY r.profile_id, r.start_date;
--     25 Sep: 11 rows, 5 people, 9 moved + 2 split, all approved,
--     reason_chars <= 9, open_cancel_ask false everywhere.
-- (d) The guards, each expected 0:
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d),
--       c AS (SELECT r.* FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t
--              WHERE r.type = 'unavailable' AND r.status IN ('approved','pending') AND r.end_date >= t.d AND p.deleted_at IS NULL)
--       SELECT (SELECT count(*) FROM c WHERE cancel_requested_at IS NOT NULL AND cancel_decided_at IS NULL) AS open_asks,
--              (SELECT count(*) FROM c WHERE char_length(reason)
--                   + char_length(regexp_replace(reason, '[^\U00010000-\U0010FFFF]', '', 'g')) > 200) AS long_notes,
--                   -- UTF-16 units of the UNTRIMMED reason: an upper bound.
--              (SELECT count(*) FROM c, t WHERE greatest(c.start_date, t.d) > t.d + 730) AS too_far,
--              (SELECT count(*) FROM (SELECT profile_id FROM (
--                  SELECT profile_id FROM c
--                  UNION ALL SELECT u.profile_id FROM public.staff_unavailability u, t WHERE u.kind = 'dated' AND u.end_date >= t.d
--                ) x GROUP BY profile_id HAVING count(*) > 60) y) AS too_many;
-- (e) FINGERPRINTS (save every value; post-check (k) compares):
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d),
--       carry AS (SELECT r.id FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t
--                  WHERE r.type = 'unavailable' AND r.status IN ('approved','pending') AND r.end_date >= t.d AND p.deleted_at IS NULL)
--       SELECT
--         (SELECT md5(string_agg(to_jsonb(s)::text, ',' ORDER BY s.id)) FROM public.staff_allowances s) AS allowances_fp,
--         (SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) FROM public.time_off_requests r
--           WHERE r.type <> 'unavailable') AS other_types_fp,
--         (SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) FROM public.time_off_requests r
--           WHERE r.type = 'unavailable' AND r.id NOT IN (SELECT id FROM carry)) AS untouched_unavailable_fp,
--         (SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) FROM public.time_off_requests r
--           WHERE r.type = 'unavailable') AS all_unavailable_fp,
--         (SELECT count(*) FROM public.staff_unavailability) AS rules,
--         (SELECT count(*) FROM public.staff_availability_changes) AS changes,
--         (SELECT count(*) FROM public.staff_availability_changes WHERE notified_at IS NULL) AS changes_owed,
--         (SELECT count(*) FROM public.push_event_sends WHERE event_key LIKE 'availability_changed:%') AS availability_pushes;
-- (f) The person-days to carry (post-check (l) must find every one covered):
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d)
--       SELECT count(*) AS person_days, count(DISTINCT (r.profile_id, g.d)) AS distinct_person_days
--         FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t,
--              generate_series(greatest(r.start_date, t.d), r.end_date, interval '1 day') g(d)
--        WHERE r.type = 'unavailable' AND r.status IN ('approved','pending') AND r.end_date >= t.d AND p.deleted_at IS NULL;
--     25 Sep: 81 person-days (one overlapping pair).
-- (g) The trigger is still only the allowance one, and it still keys on holiday:
--       SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--        WHERE tgrelid = 'public.time_off_requests'::regclass AND NOT tgisinternal;
--       SELECT pg_get_functiondef('public.update_holiday_allowance()'::regprocedure)
--              LIKE '%NEW.type = ''holiday'' AND NEW.status = ''approved''%'
--          AND pg_get_functiondef('public.update_holiday_allowance()'::regprocedure)
--              LIKE '%NEW.type = ''holiday'' AND OLD.status = ''approved''%';
--     Expected: one row, trg_update_holiday_allowance AFTER UPDATE; true.
--     AND nothing references the table (a moved row is DELETED; the move
--     itself also aborts with avail3_fk_into_time_off if this is not 0):
--       SELECT conrelid::regclass, conname FROM pg_constraint
--        WHERE contype = 'f' AND confrelid = 'public.time_off_requests'::regclass;
--     Expected: 0 rows.
-- (h) Advisor baseline: get_advisors(security) rls_enabled_no_policy count.
--
-- ─────────────────────────────────────────────────────────────────────────
-- AFTER APPLYING THIS FILE (before the move): the ledger exists and is empty
--   (SELECT count(*) FROM public.time_off_availability_moves -> 0), every
--   carry row in (c) is still in time_off_requests unchanged, and grants (n)
--   hold. get_advisors security: rls_enabled_no_policy +1 (the ledger).
--
-- POST-MOVE CHECKS (after the operator script has run)
-- ─────────────────────────────────────────────────────────────────────────
-- (i) The ledger matches the carry set in (c), row for row:
--       SELECT action, count(*), count(DISTINCT profile_id), count(*) FILTER (WHERE rule_inserted)
--         FROM public.time_off_availability_moves GROUP BY action;
--       SELECT time_off_request_id FROM public.time_off_availability_moves ORDER BY 1;  -- = the ids in (c)
-- (j) Nothing eligible remains (0):
--       WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Dublin')::date AS d)
--       SELECT count(*) FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id, t
--        WHERE r.type = 'unavailable' AND r.status IN ('approved','pending') AND r.end_date >= t.d AND p.deleted_at IS NULL;
-- (k) Fingerprints: allowances_fp and other_types_fp IDENTICAL to (e);
--     untouched_unavailable_fp, now computed as
--       (SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) FROM public.time_off_requests r
--         WHERE r.type = 'unavailable'
--           AND r.id NOT IN (SELECT time_off_request_id FROM public.time_off_availability_moves))
--     IDENTICAL to (e); changes, changes_owed, availability_pushes IDENTICAL
--     to (e) (nobody notified); rules = (e).rules + the rules_inserted in (i).
-- (l) No carried day lost (0 rows):
--       SELECT m.time_off_request_id, g.d::date
--         FROM public.time_off_availability_moves m,
--              generate_series(greatest((m.original->>'start_date')::date, m.moved_today),
--                              (m.original->>'end_date')::date, interval '1 day') g(d)
--        WHERE NOT EXISTS (SELECT 1 FROM public.staff_unavailability u
--                           WHERE u.profile_id = m.profile_id AND u.kind = 'dated' AND u.all_day
--                             AND g.d::date BETWEEN u.start_date AND u.end_date);
-- (m) Split rows kept their elapsed days (every row: same start, ends the
--     day before moved_today):
--       SELECT r.id, r.start_date, r.end_date, r.total_days, m.moved_today
--         FROM public.time_off_availability_moves m JOIN public.time_off_requests r ON r.id = m.time_off_request_id
--        WHERE m.action = 'split';
-- (n) Grants: 0 rows from
--       SELECT r, p FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
--        WHERE has_table_privilege(r, 'public.time_off_availability_moves', p);
--     and 0 rows from the same with ARRAY['service_role'] and
--     ARRAY['DELETE','TRUNCATE'] (it records and stamps, never erases);
--     and false, false from
--       SELECT has_function_privilege('authenticated', 'public.move_unavailable_time_off_to_availability(date)', 'EXECUTE'),
--              has_function_privilege('authenticated', 'public.restore_moved_unavailable_time_off(uuid)', 'EXECUTE');
-- (o) get_advisors security AND performance: rls_enabled_no_policy +1 (the
--     ledger), nothing else new (no FK, so no unindexed_foreign_keys).
-- (p) Browser eyeball (Claude in Chrome, crm.repset.ie): the week holding a
--     carried contractor's future day shows grey availability shading for
--     them and NO amber Unavailable leave bar; the coach grid shows the
--     availability, not leave; Schedule > Time Off lists no future
--     Unavailable row; the contractor's own "My availability" lists the
--     carried dates with their notes.
-- (q) 30 minutes later: cron_heartbeats 'availability-notice-sweep' fresh,
--     and availability_pushes still equal to (e).
--
-- ROLLBACK (data): SELECT public.restore_moved_unavailable_time_off();
--   then all_unavailable_fp must equal (e) again (a restored_rule_changed
--   row means the coach edited that rule since: their rule is kept, so they
--   now have both; tell them). Revert the AVAIL.3 code in the same hour if
--   the forms should offer the type again. The ledger and both functions
--   stay; drop them in a later forward migration once nobody needs them.

BEGIN;

-- ── The ledger ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.time_off_availability_moves (
  time_off_request_id uuid PRIMARY KEY,
  batch_id            uuid NOT NULL,
  profile_id          uuid NOT NULL,
  action              text NOT NULL,
  moved_today         date NOT NULL,
  original            jsonb NOT NULL,
  rule                jsonb NOT NULL,
  rule_inserted       boolean NOT NULL DEFAULT false,
  moved_at            timestamptz NOT NULL DEFAULT now(),
  restored_at         timestamptz,
  restore_outcome     text,
  CONSTRAINT time_off_availability_moves_action CHECK (action IN ('moved', 'split')),
  CONSTRAINT time_off_availability_moves_restore CHECK (
    (restored_at IS NULL AND restore_outcome IS NULL)
    OR (restored_at IS NOT NULL AND restore_outcome IN ('restored', 'restored_rule_changed', 'restored_rule_in_use'))
  )
);

CREATE INDEX IF NOT EXISTS time_off_availability_moves_batch_idx
  ON public.time_off_availability_moves (batch_id);

ALTER TABLE public.time_off_availability_moves ENABLE ROW LEVEL SECURITY;
-- service_role (the functions run as it) records and stamps the ledger and
-- never erases it: no DELETE, no TRUNCATE (Supabase's default privileges
-- would otherwise give it ALL). Deleting a ledger row (to move a restored
-- request again) is a deliberate operator step as the table owner.
REVOKE ALL ON public.time_off_availability_moves FROM anon, authenticated, service_role, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.time_off_availability_moves TO service_role;

COMMENT ON TABLE public.time_off_availability_moves IS
  'AVAIL.3 (mig 631) — one row per time_off_requests row of type unavailable carried into staff_unavailability: the FULL original row (to_jsonb), the dated all-day rule it became, whether that rule was inserted or an identical one reused, and whether the move was a delete (moved) or a split at moved_today (split). The audit and the rollback record for restore_moved_unavailable_time_off(). No FKs on purpose (it outlives what it points at). Service-role only.';

-- ── The move ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.move_unavailable_time_off_to_availability(p_today date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_batch  uuid := gen_random_uuid();
  v_n      int;
  v_moved  int;
  v_split  int;
  v_rules  int;
  v_people int;
  v_fks    text;
BEGIN
  IF p_today IS NULL THEN
    RAISE EXCEPTION 'avail3_bad_args: today is required';
  END IF;

  -- Nothing else writes time_off_requests while this runs (reads carry on).
  -- The same lock mode that adding a foreign key needs, so none can appear
  -- between the check below and the DELETE.
  LOCK TABLE public.time_off_requests IN SHARE ROW EXCLUSIVE MODE;

  -- 0. The DELETE of a moved row is only safe while NOTHING references
  --    time_off_requests (none did on 25 Sep): an FK would either cascade,
  --    silently deleting its rows, or refuse halfway. Any FK aborts the move.
  SELECT string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ' ORDER BY c.conname)
    INTO v_fks
    FROM pg_catalog.pg_constraint c
   WHERE c.contype = 'f' AND c.confrelid = 'public.time_off_requests'::regclass;
  IF v_fks IS NOT NULL THEN
    RAISE EXCEPTION 'avail3_fk_into_time_off: % references time_off_requests; a moved row is DELETED, so decide what those rows need first', v_fks;
  END IF;

  -- 1. THE CARRY SET, recorded in full before anything changes.
  INSERT INTO public.time_off_availability_moves
         (time_off_request_id, batch_id, profile_id, action, moved_today, original, rule)
  SELECT r.id, v_batch, r.profile_id,
         CASE WHEN r.start_date < p_today THEN 'split' ELSE 'moved' END,
         p_today,
         to_jsonb(r),
         jsonb_build_object(
           'kind', 'dated',
           'start_date', GREATEST(r.start_date, p_today),
           'end_date', r.end_date,
           'all_day', true,
           'start_time', NULL,
           'end_time', NULL,
           -- Trimmed exactly as JS String.prototype.trim() trims (the
           -- editor and the route normalise notes with .trim()), so the
           -- coach's first save of an untouched editor is a no-op. btrim()
           -- strips spaces only; a tab, newline or no-break space would
           -- survive it and read as a changed note.
           'note', NULLIF(regexp_replace(COALESCE(r.reason, ''),
                                         '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g'), ''))
    FROM public.time_off_requests r
    JOIN public.profiles p ON p.id = r.profile_id
   WHERE r.type = 'unavailable'
     AND r.status IN ('approved', 'pending')
     AND r.end_date >= p_today
     AND p.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.time_off_availability_moves m WHERE m.time_off_request_id = r.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 0 THEN
    RETURN jsonb_build_object('batch_id', NULL, 'moved', 0, 'split', 0,
                              'rules_inserted', 0, 'rules_reused', 0, 'people', 0);
  END IF;

  -- 2. GUARDS. A raise here rolls back step 1 with it.
  IF EXISTS (SELECT 1 FROM public.time_off_availability_moves m
              WHERE m.batch_id = v_batch
                AND (m.original->>'cancel_requested_at') IS NOT NULL
                AND (m.original->>'cancel_decided_at') IS NULL) THEN
    RAISE EXCEPTION 'avail3_open_cancel_ask: a request being carried has a cancellation no owner has decided; decide it first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.time_off_availability_moves m
              -- Counted in UTF-16 code units, as the editor counts them
              -- (shared/availability.js: note.length > noteChars): a
              -- character outside the BMP (an emoji) is ONE Postgres
              -- character but TWO units. Mig 630's CHECK counts characters,
              -- so a note it accepts could still be refused at the coach's
              -- next save; this is the stricter of the two.
              WHERE m.batch_id = v_batch
                AND char_length(m.rule->>'note')
                    + char_length(regexp_replace(m.rule->>'note', '[^\U00010000-\U0010FFFF]', '', 'g')) > 200) THEN
    RAISE EXCEPTION 'avail3_note_too_long: a reason is over 200 characters (UTF-16 units, as the editor counts), the availability note limit';
  END IF;
  IF EXISTS (SELECT 1 FROM public.time_off_availability_moves m
              WHERE m.batch_id = v_batch AND (m.rule->>'start_date')::date > p_today + 730) THEN
    RAISE EXCEPTION 'avail3_too_far_ahead: a date starts more than two years ahead';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT x.profile_id FROM (
        SELECT m.profile_id FROM public.time_off_availability_moves m WHERE m.batch_id = v_batch
        UNION ALL
        SELECT u.profile_id FROM public.staff_unavailability u
         WHERE u.kind = 'dated' AND u.end_date >= p_today
           AND u.profile_id IN (SELECT m2.profile_id FROM public.time_off_availability_moves m2 WHERE m2.batch_id = v_batch)
      ) x GROUP BY x.profile_id HAVING count(*) > 60
    ) y
  ) THEN
    RAISE EXCEPTION 'avail3_too_many_dates: someone would have more than 60 dated availability entries';
  END IF;

  -- 3. One writer per person at a time: the same lock the AVAIL.1 RPC takes,
  --    in a fixed order, so a coach saving right now queues behind the move.
  PERFORM pg_advisory_xact_lock(hashtextextended('staff_unavailability:' || x.profile_id::text, 0))
     FROM (SELECT DISTINCT m.profile_id FROM public.time_off_availability_moves m
            WHERE m.batch_id = v_batch ORDER BY m.profile_id) x;

  -- 4. Which rules to insert: one per (person, start, end), the earliest
  --    request's, and none where the person already has that all-day rule.
  UPDATE public.time_off_availability_moves m
     SET rule_inserted = true
   WHERE m.time_off_request_id IN (
     SELECT DISTINCT ON (b.profile_id, b.rule->>'start_date', b.rule->>'end_date') b.time_off_request_id
       FROM public.time_off_availability_moves b
      WHERE b.batch_id = v_batch
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_unavailability u
           WHERE u.profile_id = b.profile_id AND u.kind = 'dated' AND u.all_day
             AND u.start_date = (b.rule->>'start_date')::date
             AND u.end_date = (b.rule->>'end_date')::date)
      ORDER BY b.profile_id, b.rule->>'start_date', b.rule->>'end_date',
               -- By the instant, never the text: to_jsonb renders the
               -- session's offset, which changes at a clock change.
               (b.original->>'created_at')::timestamptz NULLS LAST, b.time_off_request_id);

  -- The mig 630 CHECKs judge every row: one bad rule aborts everything.
  INSERT INTO public.staff_unavailability (profile_id, kind, start_date, end_date, all_day, note)
  SELECT m.profile_id, 'dated', (m.rule->>'start_date')::date, (m.rule->>'end_date')::date, true, m.rule->>'note'
    FROM public.time_off_availability_moves m
   WHERE m.batch_id = v_batch AND m.rule_inserted;
  GET DIAGNOSTICS v_rules = ROW_COUNT;

  -- 5. Time off. The split UPDATE fires trg_update_holiday_allowance, which
  --    acts on type 'holiday' only; these rows are 'unavailable'.
  UPDATE public.time_off_requests r
     SET end_date = p_today - 1,
         total_days = LEAST(r.total_days, (p_today - r.start_date)::numeric),
         updated_at = now()
    FROM public.time_off_availability_moves m
   WHERE m.batch_id = v_batch AND m.action = 'split' AND r.id = m.time_off_request_id;
  GET DIAGNOSTICS v_split = ROW_COUNT;

  DELETE FROM public.time_off_requests r
   USING public.time_off_availability_moves m
   WHERE m.batch_id = v_batch AND m.action = 'moved' AND r.id = m.time_off_request_id;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- 6. PROVE IT before returning. Any failure raises; the caller's
  --    transaction (the migration, or a manual re-run) rolls back whole.
  IF v_moved + v_split <> v_n THEN
    RAISE EXCEPTION 'avail3_postcheck: % rows recorded, % moved + % split', v_n, v_moved, v_split;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.time_off_availability_moves m,
           generate_series((m.rule->>'start_date')::date, (m.rule->>'end_date')::date, interval '1 day') g(d)
     WHERE m.batch_id = v_batch
       AND NOT EXISTS (SELECT 1 FROM public.staff_unavailability u
                        WHERE u.profile_id = m.profile_id AND u.kind = 'dated' AND u.all_day
                          AND g.d::date BETWEEN u.start_date AND u.end_date)
  ) THEN
    RAISE EXCEPTION 'avail3_postcheck: a carried day is not covered by an availability rule';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.time_off_availability_moves m
      LEFT JOIN public.time_off_requests r ON r.id = m.time_off_request_id
     WHERE m.batch_id = v_batch AND m.action = 'split'
       AND (r.id IS NULL OR r.type <> 'unavailable'
            OR r.start_date <> (m.original->>'start_date')::date
            OR r.end_date <> p_today - 1
            OR r.status <> (m.original->>'status'))
  ) THEN
    RAISE EXCEPTION 'avail3_postcheck: a split row lost its elapsed days';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.time_off_requests r JOIN public.profiles p ON p.id = r.profile_id
     WHERE r.type = 'unavailable' AND r.status IN ('approved', 'pending')
       AND r.end_date >= p_today AND p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.time_off_availability_moves m
                        WHERE m.time_off_request_id = r.id AND m.restored_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'avail3_postcheck: an eligible unavailable request is still time off';
  END IF;

  SELECT count(DISTINCT m.profile_id) INTO v_people
    FROM public.time_off_availability_moves m WHERE m.batch_id = v_batch;

  RETURN jsonb_build_object('batch_id', v_batch, 'moved', v_moved, 'split', v_split,
                            'rules_inserted', v_rules, 'rules_reused', v_n - v_rules, 'people', v_people);
END;
$$;

COMMENT ON FUNCTION public.move_unavailable_time_off_to_availability(date) IS
  'AVAIL.3 (mig 631) — carries every time_off_requests row of type unavailable (approved or pending, end_date >= p_today, person not tombstoned, not already in the ledger) into staff_unavailability as an all-day dated rule from greatest(start_date, p_today): future rows are deleted, started rows split at p_today (start..p_today-1 stays time off). Full originals go to time_off_availability_moves first. Writes no staff_availability_changes row, so nobody is notified. Guards (avail3_*) abort everything; proves no day lost before returning. Idempotent. service_role only.';

REVOKE ALL ON FUNCTION public.move_unavailable_time_off_to_availability(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_unavailable_time_off_to_availability(date) TO service_role;

-- ── The rollback ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_moved_unavailable_time_off(p_batch_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  m                 record;
  k                 record;
  ins               record;
  v_ids             uuid[] := '{}';
  v_rule_id         uuid;
  v_restored        int := 0;
  v_rules_removed   int := 0;
  v_rules_changed   int := 0;
  v_rules_kept      int := 0;
  v_missing         text;
  v_cols            text;
BEGIN
  LOCK TABLE public.time_off_requests IN SHARE ROW EXCLUSIVE MODE;

  -- 0. THE SHAPE. The ledger's copies are to_jsonb of the row as it was at
  --    the move. A column ADDED to time_off_requests since is fine: the
  --    INSERT below names only the saved columns, so a new one takes its
  --    default. A saved column that NO LONGER EXISTS cannot come back, and a
  --    restore that silently lost it would not be byte-for-byte, so refuse
  --    before anything is written and say which.
  SELECT string_agg(DISTINCT sk.key, ', ' ORDER BY sk.key) INTO v_missing
    FROM public.time_off_availability_moves l,
         jsonb_object_keys(l.original) AS sk(key)
   WHERE l.restored_at IS NULL AND (p_batch_id IS NULL OR l.batch_id = p_batch_id)
     AND l.action = 'moved'
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                      WHERE a.attrelid = 'public.time_off_requests'::regclass
                        AND a.attname = sk.key AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'avail3_restore_shape: saved column(s) % no longer exist on time_off_requests; restore those rows by hand from time_off_availability_moves.original', v_missing;
  END IF;

  -- 1. THE TIME OFF: every ledger row in scope goes back.
  FOR m IN
    SELECT * FROM public.time_off_availability_moves
     WHERE restored_at IS NULL AND (p_batch_id IS NULL OR batch_id = p_batch_id)
     ORDER BY profile_id, time_off_request_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('staff_unavailability:' || m.profile_id::text, 0));

    IF m.action = 'moved' THEN
      -- The exact row, same id, every SAVED column as it was; a column added
      -- since takes its default (dynamic, so the row type is read now, not
      -- when this function was first planned).
      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
        FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.time_off_requests'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
         AND m.original ? a.attname;
      EXECUTE format(
        'INSERT INTO public.time_off_requests (%1$s) SELECT %1$s FROM pg_catalog.jsonb_populate_record(NULL::public.time_off_requests, $1) ON CONFLICT (id) DO NOTHING',
        v_cols) USING m.original;
    ELSE
      -- AFTER UPDATE trigger: type 'unavailable', so no allowance moves.
      UPDATE public.time_off_requests r
         SET end_date = (m.original->>'end_date')::date,
             total_days = (m.original->>'total_days')::numeric,
             updated_at = (m.original->>'updated_at')::timestamptz
       WHERE r.id = m.time_off_request_id;
    END IF;

    UPDATE public.time_off_availability_moves
       SET restored_at = now(), restore_outcome = 'restored'
     WHERE time_off_request_id = m.time_off_request_id;
    v_ids := v_ids || m.time_off_request_id;
    v_restored := v_restored + 1;
  END LOOP;

  -- 2. THE RULES, one decision per (person, start, end) this call touched.
  --    A rule is keyed by its range, not by the ledger row that inserted it:
  --    a straggler moved in a LATER batch reuses an identical rule an earlier
  --    batch inserted (rule_inserted = false), and its request is gone from
  --    time off, so that rule is the only record of its days. It is removed
  --    only when NO ledger row of that range is left un-restored, and then
  --    once for each ledger row (any batch) that inserted one.
  FOR k IN
    SELECT DISTINCT l.profile_id, l.rule->>'start_date' AS s, l.rule->>'end_date' AS e
      FROM public.time_off_availability_moves l
     WHERE l.time_off_request_id = ANY (v_ids)
     ORDER BY 1, 2, 3
  LOOP
    -- The move never inserted a rule for this range (the person's own was
    -- reused): nothing of ours to remove.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.time_off_availability_moves l
       WHERE l.profile_id = k.profile_id AND l.rule->>'start_date' = k.s AND l.rule->>'end_date' = k.e
         AND l.rule_inserted);

    -- Still relied on by a move this call is not restoring: keep it.
    IF EXISTS (
      SELECT 1 FROM public.time_off_availability_moves l
       WHERE l.profile_id = k.profile_id AND l.rule->>'start_date' = k.s AND l.rule->>'end_date' = k.e
         AND l.restored_at IS NULL) THEN
      UPDATE public.time_off_availability_moves l
         SET restore_outcome = 'restored_rule_in_use'
       WHERE l.time_off_request_id = ANY (v_ids)
         AND l.profile_id = k.profile_id AND l.rule->>'start_date' = k.s AND l.rule->>'end_date' = k.e;
      v_rules_kept := v_rules_kept + 1;
      CONTINUE;
    END IF;

    FOR ins IN
      SELECT l.time_off_request_id, l.rule->>'note' AS note
        FROM public.time_off_availability_moves l
       WHERE l.profile_id = k.profile_id AND l.rule->>'start_date' = k.s AND l.rule->>'end_date' = k.e
         AND l.rule_inserted
       ORDER BY l.moved_at, l.time_off_request_id
    LOOP
      SELECT u.id INTO v_rule_id
        FROM public.staff_unavailability u
       WHERE u.profile_id = k.profile_id AND u.kind = 'dated' AND u.all_day
         AND u.start_date = k.s::date AND u.end_date = k.e::date
         AND u.note IS NOT DISTINCT FROM ins.note
       ORDER BY u.created_at, u.id
       LIMIT 1;
      IF v_rule_id IS NOT NULL THEN
        DELETE FROM public.staff_unavailability WHERE id = v_rule_id;
        v_rules_removed := v_rules_removed + 1;
        -- The inserting row may have been restored by an earlier call
        -- ('restored_rule_in_use'); its rule is gone now.
        UPDATE public.time_off_availability_moves
           SET restore_outcome = 'restored'
         WHERE time_off_request_id = ins.time_off_request_id;
      ELSE
        -- The person changed or removed it since: their rule stays.
        v_rules_changed := v_rules_changed + 1;
        UPDATE public.time_off_availability_moves
           SET restore_outcome = 'restored_rule_changed'
         WHERE time_off_request_id = ins.time_off_request_id;
      END IF;
    END LOOP;
    -- Every reuser of this range restored earlier as 'in use' is settled too.
    UPDATE public.time_off_availability_moves l
       SET restore_outcome = 'restored'
     WHERE l.profile_id = k.profile_id AND l.rule->>'start_date' = k.s AND l.rule->>'end_date' = k.e
       AND NOT l.rule_inserted AND l.restore_outcome = 'restored_rule_in_use';
  END LOOP;

  RETURN jsonb_build_object('restored', v_restored, 'rules_removed', v_rules_removed,
                            'rules_changed_since', v_rules_changed, 'rules_kept_in_use', v_rules_kept);
END;
$$;

COMMENT ON FUNCTION public.restore_moved_unavailable_time_off(uuid) IS
  'AVAIL.3 (mig 631) — the rollback of move_unavailable_time_off_to_availability: re-inserts every moved row byte-for-byte (same id; a column added since takes its default, a saved column since dropped refuses with avail3_restore_shape), re-extends every split row, and deletes each carried rule the person has not changed since (else restore_outcome = restored_rule_changed and their rule stays). A rule is removed only once no un-restored ledger row of the same (person, start, end) remains, so restoring one batch never deletes a rule a later batch reused (restore_outcome = restored_rule_in_use until that batch is restored too). One batch, or all when p_batch_id is NULL. Idempotent (restored_at). service_role only.';

REVOKE ALL ON FUNCTION public.restore_moved_unavailable_time_off(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_moved_unavailable_time_off(uuid) TO service_role;

-- ── The move itself is NOT here ──────────────────────────────────────────
-- Held for the owner's explicit go: supabase/operator-scripts/
-- 631_run_move_unavailable_time_off.sql calls the function above. Applying
-- this file leaves every time_off_requests row exactly as it was.

-- ── Self-check against the catalog, never this text (the mig 153 lesson) ──
DO $$
DECLARE
  v_role text;
  v_priv text;
  v_n    int;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.time_off_availability_moves', v_priv) THEN
        RAISE EXCEPTION 'mig 631: % still holds % on the ledger', v_role, v_priv;
      END IF;
    END LOOP;
    IF has_function_privilege(v_role, 'public.move_unavailable_time_off_to_availability(date)', 'EXECUTE')
       OR has_function_privilege(v_role, 'public.restore_moved_unavailable_time_off(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 631: % can execute a move function', v_role;
    END IF;
  END LOOP;

  FOREACH v_priv IN ARRAY ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('service_role', 'public.time_off_availability_moves', v_priv) THEN
      RAISE EXCEPTION 'mig 631: service_role still holds % on the ledger', v_priv;
    END IF;
  END LOOP;

  IF NOT has_function_privilege('service_role', 'public.move_unavailable_time_off_to_availability(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.restore_moved_unavailable_time_off(uuid)', 'EXECUTE')
     OR NOT has_table_privilege('service_role', 'public.time_off_availability_moves', 'SELECT') THEN
    RAISE EXCEPTION 'mig 631: service_role lacks what the functions need';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.time_off_availability_moves'::regclass) THEN
    RAISE EXCEPTION 'mig 631: RLS is not enabled on the ledger';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'time_off_availability_moves';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'mig 631: expected no policies on the ledger, found %', v_n;
  END IF;

  -- The ledger starts empty: this file moves nothing (the move is held).
  SELECT count(*) INTO v_n FROM public.time_off_availability_moves;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'mig 631: expected an empty ledger after install, found % rows', v_n;
  END IF;
END $$;

COMMIT;
