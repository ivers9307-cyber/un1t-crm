-- 604 — ROSTER-FIX.8b: per-coach overlap guard on shift_assignments.
--
-- 🔴 ADVISORY ONLY. This trigger RAISEs a WARNING, never an exception. It
-- cannot refuse a write today, and nothing in the product behaves differently
-- because it exists. Read the "why it only warns" section before arming it.
--
-- WHAT IT CATCHES
-- ───────────────
-- The same coach on two shifts whose paid windows overlap on the same day.
-- Nothing in the database prevented this: the (block_id, profile_id) unique
-- key from mig 067 stops the same coach on the same BLOCK twice, which is a
-- different statement — two different templates on the same morning overlap
-- freely, and so does a partial-shift override stretched over a neighbour.
--
-- WHY A TRIGGER AND NOT AN EXCLUSION CONSTRAINT
-- ─────────────────────────────────────────────
-- An EXCLUDE constraint (btree_gist over profile_id + a tsrange) needs the
-- range on the row it constrains. The times are on shift_blocks, not on
-- shift_assignments, and the per-assignment overrides are on the assignment —
-- so the window is a join, which an exclusion constraint cannot express. No
-- btree_gist extension is created here because nothing uses it.
--
-- 🔴 WHY IT ONLY WARNS (the deferred half)
-- ────────────────────────────────────────
-- The design calls for the trigger to RAISE EXCEPTION with SQLSTATE 'P0001',
-- for the routes to catch it and answer 409, and for a deliberate operator
-- override to set `app.allow_overlap = 'on'` for the statement so the same
-- write goes through. That last part is what does not exist: there is no
-- pattern anywhere in this codebase for a route to pass a GUC to Postgres —
-- `grep -rn "set_config|SET LOCAL|app\." src/lib src/app/api` returns nothing.
-- Every route talks to Supabase over PostgREST, where each statement is its
-- own implicit transaction and a `SET LOCAL` from a separate call would not
-- reach it; an RPC that does `set_config(...)` and the write together would
-- have to be written first.
--
-- Arming the raise without that escape hatch would mean a manager who
-- genuinely wants a coach on two overlapping shifts (a cover handover, a
-- 15-minute tail) simply cannot save it, with a 500 and no way round —
-- turning a rare wrong value into a certain loss of a legitimate operation.
-- So it warns. The warning lands in Postgres logs, which is where to count
-- how often this actually happens before deciding it is worth a hard stop.
--
-- TO ARM IT LATER (one line, plus the route work):
--   1. Build the GUC-passing path (an RPC that sets app.allow_overlap and
--      performs the write in one statement is the obvious shape).
--   2. Replace `RAISE WARNING '%', v_msg;` below with
--      `RAISE EXCEPTION '%', v_msg;` (bare RAISE EXCEPTION is SQLSTATE
--      'P0001' already — no USING clause needed).
--   3. Routes catch code 'P0001' + the `overlapping_shift:` prefix and answer
--      409 with the message, unless the request asked to override.
-- The `app.allow_overlap` check is already wired below so step 2 is the only
-- change to this object.
--
-- KNOWN GAPS, on purpose
-- ──────────────────────
--   * ROSTER-FIX.8e — CLOSED. The trigger fires on INSERT and on UPDATE OF
--     block_id, profile_id, status, start_time_override, end_time_override.
--     It used to omit the two override columns, which meant the one edit that
--     most often creates an overlap — a manager stretching one shift over its
--     neighbour via PUT /api/schedule/assignments/[id], which touches nothing
--     but the overrides — never re-fired the guard. Both sides of the
--     comparison read EFFECTIVE times (COALESCE(override, block time)), so an
--     override on the row being written and an override on the row it clashes
--     with are both honoured.
--   * A change to shift_blocks.start_time / end_time can create an overlap
--     without touching shift_assignments at all. Not covered.
--   * Overnight shifts are not a case: shift_blocks_time_order (mig 067)
--     already requires end_time > start_time.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (run read-only BEFORE applying this file)
-- ─────────────────────────────────────────────────────────────────────────
--
-- (a) How many overlaps already exist. This is the number that would become
--     un-saveable the day the raise is armed, so it is the number that
--     decides whether arming is realistic at all:
--
--       SELECT count(*) AS overlapping_pairs
--         FROM public.shift_assignments a
--         JOIN public.shift_blocks ba ON ba.id = a.block_id
--         JOIN public.shift_assignments b ON b.profile_id = a.profile_id
--                                        AND b.id > a.id
--         JOIN public.shift_blocks bb ON bb.id = b.block_id
--        WHERE COALESCE(a.status, 'scheduled') <> 'cancelled'
--          AND COALESCE(b.status, 'scheduled') <> 'cancelled'
--          AND ba.block_date = bb.block_date
--          AND COALESCE(a.start_time_override, ba.start_time)
--              < COALESCE(b.end_time_override, bb.end_time)
--          AND COALESCE(a.end_time_override, ba.end_time)
--              > COALESCE(b.start_time_override, bb.start_time);
--     Expected: unknown, and that is the point of running it. A warning-only
--     trigger is correct at any number; a non-trivial number is the argument
--     for leaving it that way.
--
--     Drop the `count(*) AS overlapping_pairs` for `a.profile_id,
--     ba.block_date, ba.start_time, ba.end_time, bb.start_time, bb.end_time`
--     to see which days they are, before deciding anything.
--
-- (b) Nothing else is named `shift_assignments_overlap_guard`:
--
--       SELECT tgname FROM pg_trigger
--        WHERE tgrelid = 'public.shift_assignments'::regclass
--          AND NOT tgisinternal;
--     Expected: no row named shift_assignments_overlap_guard (mig 238 dropped
--     the two legacy mirror triggers; this table should have none left).
--
-- AFTER APPLYING: get_advisors (type=security). The function is SECURITY
-- INVOKER with a pinned search_path, so it should raise nothing.

CREATE OR REPLACE FUNCTION public.shift_assignments_warn_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_date  date;
  v_start time;
  v_end   time;
  v_clash record;
  v_msg   text;
BEGIN
  -- A cancelled row is not live, so it can neither clash nor be clashed with.
  -- (ROSTER-FIX.1 retired the state; legacy rows with a NULL status are live.)
  IF COALESCE(NEW.status, 'scheduled') = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- The deliberate-override escape hatch. Nothing sets this today (see the
  -- header); it is wired now so arming the raise is a one-line change.
  IF COALESCE(current_setting('app.allow_overlap', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT b.block_date,
         COALESCE(NEW.start_time_override, b.start_time),
         COALESCE(NEW.end_time_override, b.end_time)
    INTO v_date, v_start, v_end
    FROM public.shift_blocks b
   WHERE b.id = NEW.block_id;

  -- No block (impossible under the FK) or no window: nothing to compare.
  IF v_date IS NULL OR v_start IS NULL OR v_end IS NULL THEN
    RETURN NEW;
  END IF;

  -- [start, end) — touching shifts (one ends exactly as the next begins) are
  -- NOT an overlap, which is the common back-to-back roster shape.
  SELECT b2.block_date,
         COALESCE(t2.name, 'shift')                        AS template_name,
         COALESCE(a2.start_time_override, b2.start_time)   AS clash_start,
         COALESCE(a2.end_time_override, b2.end_time)       AS clash_end
    INTO v_clash
    FROM public.shift_assignments a2
    JOIN public.shift_blocks b2 ON b2.id = a2.block_id
    LEFT JOIN public.shift_templates t2 ON t2.id = b2.template_id
   WHERE a2.profile_id = NEW.profile_id
     AND a2.id <> NEW.id
     AND COALESCE(a2.status, 'scheduled') <> 'cancelled'
     AND b2.block_date = v_date
     AND COALESCE(a2.start_time_override, b2.start_time) < v_end
     AND COALESCE(a2.end_time_override, b2.end_time) > v_start
   LIMIT 1;

  IF FOUND THEN
    v_msg := format(
      'overlapping_shift: this coach is already on %s on %s from %s to %s, which overlaps %s to %s',
      v_clash.template_name,
      to_char(v_clash.block_date, 'YYYY-MM-DD'),
      to_char(v_clash.clash_start, 'HH24:MI'),
      to_char(v_clash.clash_end, 'HH24:MI'),
      to_char(v_start, 'HH24:MI'),
      to_char(v_end, 'HH24:MI')
    );
    -- ADVISORY. To arm: RAISE EXCEPTION '%', v_msg;  (SQLSTATE 'P0001')
    RAISE WARNING '%', v_msg;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.shift_assignments_warn_overlap() IS
  'ROSTER-FIX.8b (mig 604) — advisory per-coach overlap guard. WARNS ONLY; it never refuses a write. Suppressed by SET app.allow_overlap = ''on''. Arming it means turning the RAISE WARNING into RAISE EXCEPTION, which needs a route-side way to set that GUC first — none exists in this codebase.';

DROP TRIGGER IF EXISTS shift_assignments_overlap_guard ON public.shift_assignments;
CREATE TRIGGER shift_assignments_overlap_guard
  BEFORE INSERT OR UPDATE OF block_id, profile_id, status,
                             start_time_override, end_time_override
  ON public.shift_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.shift_assignments_warn_overlap();
