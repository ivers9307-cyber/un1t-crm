-- 612 — SWAPATOMIC.1: approve a reciprocal shift swap in ONE transaction.
--
-- THE BUG
-- ───────
-- PUT /api/schedule/swaps/[id] approved a two-way swap (effect
-- `approved_swap`) as THREE separate PostgREST calls, each its own implicit
-- transaction:
--   1. shift_swap_requests  -> status 'approved'
--   2. shift_assignments[requester_shift] -> profile_id = target coach, 'swapped'
--   3. shift_assignments[target_shift]    -> profile_id = requester,    'swapped'
-- A failure at 2 left the swap approved with nobody moved; a failure at 3
-- left the swap approved, ONE coach moved and the other not (the target coach
-- then holds both shifts). The route answered 400 but nothing rolled back,
-- nothing retried (the swap is terminal, so it cannot be re-approved), and
-- SWAPAUDIT.1 writes roster_change_log only after every op succeeds, so the
-- half-move left no audit row either.
--
-- WHY THE SECOND WRITE CAN FAIL (checked against live prod, 17 Sep)
-- ─────────────────────────────────────────────────────────────────
--   * UNIQUE (block_id, profile_id) — shift_assignments_block_id_profile_id_key
--     (mig 067) is NOT DEFERRABLE, and Postgres checks a non-deferrable unique
--     key per ROW, not at statement end. So:
--       - both shifts on the SAME block: write 2 puts the target coach on that
--         block twice for an instant -> 23505, even though the final state
--         (same two coaches on the block) would be valid. Nothing at creation
--         (POST /api/schedule/swaps) forbids naming a same-block target shift.
--       - requester already holds another row on the target's block (e.g. a
--         manager added them after the request was made): write 2 is refused
--         AFTER write 1 moved the target coach — the partial state.
--   * The overlap guard (mig 604) is a BEFORE ROW trigger but it only RAISEs
--     WARNING (confirmed live: no RAISE EXCEPTION in the body), so today it
--     cannot fail a write. It DOES see the intermediate state: after write 1
--     the target coach holds both shifts, so two same-day overlapping shifts
--     log a spurious `overlapping_shift` warning — and the day the guard is
--     armed (its header's plan) that spurious warning becomes a refused swap.
--   * Plain transport/timeout failure between two HTTP calls — no DB rule
--     needed at all.
--   * Silent no-op: an .update().eq('id', x) matching zero rows is not an
--     error, so a deleted shift (FK is ON DELETE SET NULL since mig 603) made
--     the route report success for a swap that moved nobody.
--
-- THE FIX
-- ───────
-- One plpgsql function does the swap-row approval AND both assignment moves in
-- the single transaction PostgREST wraps an RPC in. Any RAISE rolls back all of
-- it, so the three writes land together or not at all.
--
-- Why the swap-row update lives INSIDE the function (rather than a bare
-- swap_shift_assignment_profiles(a, b) the route calls before/after its own
-- update): with two calls there is always an ordering that leaves a partial
-- state — approve-then-move strands an approved swap, move-then-approve
-- strands moved coaches on a still-open swap, and re-approving that open swap
-- would swap them straight BACK. Inside one function it also closes the
-- concurrent double-approve: the swap row is locked FOR UPDATE and its status
-- re-checked, so a second manager's approval (which passed the route's
-- resolver on a stale read) fails instead of reversing the first.
--
-- The assignment ids are read from the locked swap row, never taken from the
-- caller. The caller passes the profile ids it READ (the resolver's view and
-- what SWAPAUDIT.1 writes into roster_change_log); if either row has changed
-- hands since, the function refuses (swap_stale) rather than moving a third
-- coach and writing an audit trail that names the wrong people.
--
-- The intermediate-state problem:
--   * Same block: no single UPDATE can pass a non-deferrable per-row unique
--     check, and making the key DEFERRABLE would stop it serving as an
--     ON CONFLICT arbiter. A same-block reciprocal swap changes no roster
--     membership (the same two coaches staff that block before and after), so
--     it is refused up front as swap_same_block rather than half-applied.
--   * A coach already on the other block: the FINAL state would duplicate
--     (block, coach) too, so it is genuinely invalid; checked explicitly first
--     so the answer is a clean swap_conflict, not a raw 23505.
--   * Otherwise both rows are moved by ONE `UPDATE` (a CASE on id). With distinct
--     blocks and no pre-existing (block, coach) row, no row in that statement
--     can collide on the unique key in any processing order.
--   * Overlap guard: a row-level BEFORE trigger inside a multi-row UPDATE sees
--     rows already processed by that statement but not the rest, so whichever
--     row goes first ALWAYS sees the mid state. A single UPDATE therefore does
--     not fix it alone. The function sets the guard's own escape hatch
--     (`app.allow_overlap`, mig 604) for the move statement only, restores the
--     caller's previous value, then re-fires the guard with a no-op
--     `SET status = status` on both rows (UPDATE OF fires on a column named in
--     SET, whatever its value). That second pass runs against the FINAL state,
--     so a real overlap the swap creates still warns — and would still refuse,
--     rolling the whole approval back, once the guard is armed — while the
--     transient one never does.
--
-- ERRORS (all P0001, message prefix is the contract the route maps to 409):
--   swap_not_found, swap_not_open, swap_shift_missing, swap_stale,
--   swap_same_block, swap_conflict.
--
-- SECURITY: SECURITY INVOKER, search_path pinned empty, every name
-- schema-qualified. EXECUTE only for service_role (the route's client);
-- revoked from PUBLIC/anon/authenticated, mig 496 posture.
--
-- AFTER APPLYING: get_advisors (type=security).

CREATE OR REPLACE FUNCTION public.approve_reciprocal_shift_swap(
  p_swap_id           uuid,
  p_reviewed_by       uuid,
  p_reviewed_at       timestamptz,
  p_review_note       text,
  p_requester_profile uuid,
  p_target_profile    uuid
)
RETURNS public.shift_swap_requests
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_swap  public.shift_swap_requests;
  v_req   public.shift_assignments;
  v_tgt   public.shift_assignments;
  v_prev_allow text;
BEGIN
  -- 1. Lock the swap row and re-check it is still open.
  SELECT * INTO v_swap
    FROM public.shift_swap_requests
   WHERE id = p_swap_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swap_not_found: swap % does not exist', p_swap_id;
  END IF;
  IF COALESCE(v_swap.status, '') NOT IN ('pending', 'awaiting_approval') THEN
    RAISE EXCEPTION 'swap_not_open: swap is already %', COALESCE(v_swap.status, 'unknown');
  END IF;
  IF v_swap.requester_shift_id IS NULL OR v_swap.target_shift_id IS NULL
     OR v_swap.requester_shift_id = v_swap.target_shift_id THEN
    RAISE EXCEPTION 'swap_shift_missing: one of the shifts in this swap no longer exists';
  END IF;

  -- 2. Lock both assignments in id order (a fixed order, so two concurrent
  --    swaps over the same pair cannot deadlock), then read them.
  PERFORM 1
     FROM public.shift_assignments
    WHERE id IN (v_swap.requester_shift_id, v_swap.target_shift_id)
    ORDER BY id
    FOR UPDATE;

  SELECT * INTO v_req FROM public.shift_assignments WHERE id = v_swap.requester_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swap_shift_missing: the requester''s shift no longer exists';
  END IF;
  SELECT * INTO v_tgt FROM public.shift_assignments WHERE id = v_swap.target_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swap_shift_missing: the target shift no longer exists';
  END IF;

  -- 3. The rows must still belong to the coaches the caller read.
  IF p_requester_profile IS NULL OR p_target_profile IS NULL
     OR v_req.profile_id IS DISTINCT FROM p_requester_profile
     OR v_tgt.profile_id IS DISTINCT FROM p_target_profile THEN
    RAISE EXCEPTION 'swap_stale: one of these shifts has changed hands since the swap was requested';
  END IF;

  -- 4. States no swap can reach cleanly (see header).
  IF v_req.block_id = v_tgt.block_id THEN
    RAISE EXCEPTION 'swap_same_block: both shifts are on the same block, so the swap would change nothing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shift_assignments a
     WHERE (a.block_id = v_req.block_id AND a.profile_id = v_tgt.profile_id AND a.id <> v_tgt.id)
        OR (a.block_id = v_tgt.block_id AND a.profile_id = v_req.profile_id AND a.id <> v_req.id)
  ) THEN
    RAISE EXCEPTION 'swap_conflict: one of the coaches is already on the other shift''s block';
  END IF;

  -- 5. Move both rows in ONE statement, with the overlap guard's escape hatch
  --    on for this statement only (it would otherwise judge a mid state).
  v_prev_allow := COALESCE(current_setting('app.allow_overlap', true), '');
  PERFORM set_config('app.allow_overlap', 'on', true);

  UPDATE public.shift_assignments AS sa
     SET profile_id = CASE sa.id WHEN v_req.id THEN v_tgt.profile_id ELSE v_req.profile_id END,
         status     = 'swapped'
   WHERE sa.id IN (v_req.id, v_tgt.id);

  PERFORM set_config('app.allow_overlap', v_prev_allow, true);

  -- 6. Re-fire the overlap guard against the FINAL state (UPDATE OF status
  --    fires because status is in the SET list, even unchanged).
  UPDATE public.shift_assignments AS sa
     SET status = sa.status
   WHERE sa.id IN (v_req.id, v_tgt.id);

  -- 7. Approve the swap row last, in the same transaction.
  UPDATE public.shift_swap_requests AS s
     SET status      = 'approved',
         reviewed_by = p_reviewed_by,
         reviewed_at = COALESCE(p_reviewed_at, now()),
         review_note = p_review_note
   WHERE s.id = v_swap.id
  RETURNING s.* INTO v_swap;

  RETURN v_swap;
END;
$$;

COMMENT ON FUNCTION public.approve_reciprocal_shift_swap(uuid, uuid, timestamptz, text, uuid, uuid) IS
  'SWAPATOMIC.1 (mig 612) — approves a reciprocal shift swap atomically: locks the swap + both assignments, verifies they are unchanged, swaps profile_id (status swapped) in one UPDATE and stamps the swap approved, all in one transaction. Errors are P0001 with a swap_* message prefix. service_role only.';

REVOKE ALL ON FUNCTION public.approve_reciprocal_shift_swap(uuid, uuid, timestamptz, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_reciprocal_shift_swap(uuid, uuid, timestamptz, text, uuid, uuid) TO service_role;
