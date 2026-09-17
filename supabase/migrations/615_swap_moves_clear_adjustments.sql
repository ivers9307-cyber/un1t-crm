-- 615 — SWAPS.2: a shift that changes hands starts clean, and every approved
-- swap effect (reciprocal, reassign, drop) is ONE transaction.
--
-- 1. ADJUSTMENTS MOVED WITH THE SHIFT
-- ───────────────────────────────────
-- An approved swap moved a shift_assignments row to a new coach by rewriting
-- profile_id and nothing else. Everything on that row that described the
-- PREVIOUS coach's shift went with it:
--   * start_time_override / end_time_override / partial_reason (mig 099) —
--     the manager-set paid window for THAT coach ("left at 11, sick"). The
--     new coach inherited a shortened or stretched paid window they never
--     worked, and every hours/cost reader bills the override first.
--   * arrived_at / arrival_source (mig 609, ARRIVAL.1) — the previous coach's
--     phone check-in, now reading as the new coach having arrived.
-- The new coach works the BLOCK's times, so all five are cleared on every
-- row that changes hands. The block's own start/end are untouched.
--
-- 2. REASSIGN AND DROP WERE NOT ATOMIC
-- ────────────────────────────────────
-- SWAPATOMIC.1 (mig 612) fixed the reciprocal swap. The other two approved
-- effects still ran as separate PostgREST calls from the route:
--   approved_reassign: swap row -> 'approved', THEN UPDATE the assignment
--   approved_drop:     swap row -> 'approved', THEN DELETE the assignment
-- so a failed second call left an approved (terminal, un-re-approvable) swap
-- with nobody moved / the coach still on the shift, and a zero-row UPDATE
-- (the assignment deleted meanwhile) reported success for a move that never
-- happened. The resolver also judged the swap on a stale read: a coach
-- claiming a pool swap between the manager's page load and their Approve
-- turned "drop" into "claimed", and the route would still DELETE the shift
-- instead of handing it to the claimant.
--
-- THE FIX
-- ───────
--   * approve_reciprocal_shift_swap — CREATE OR REPLACE of mig 612's function,
--     IDENTICAL except that the move UPDATE (step 5) also clears the five
--     columns above on both rows. Signature, checks, error prefixes, comment
--     and grants unchanged.
--   * approve_reassign_shift_swap — new, 612's shape: lock the swap, open
--     check, lock + read the assignment, stale check (the assignment still
--     belongs to the requester the caller read, the swap still names the
--     taker the caller read, and it is still a reassign), conflict check (the
--     taker already has a row on that block), move + clear, approve last.
--   * approve_drop_shift_swap — new, same shape: lock, open check, lock +
--     read, stale check (still the requester's shift, and still UNCLAIMED —
--     a claim since the read means approving would hand the shift to nobody
--     instead of to the claimant), DELETE, approve last.
--
-- Overlap guard (mig 604): 612 needs the `app.allow_overlap` hatch plus a
-- re-fire because a TWO-row UPDATE shows the BEFORE ROW trigger an
-- intermediate state. The reassign moves ONE row in ONE statement, so the
-- trigger's single firing already judges the final state (and sees the
-- cleared overrides, since they are in the same NEW row) — no hatch, no
-- re-fire. A DELETE never fires the guard (INSERT / UPDATE OF only), and
-- removing a coach cannot create an overlap. Neither function touches the
-- GUC, so a caller's own setting is left exactly as it was.
--
-- The drop's roster_change_log row: the route used to write it BEFORE the
-- delete (nothing to describe afterwards). It now writes it only after this
-- function succeeds, from the swap + embed it read before calling, so a
-- refused drop never leaves an audit row claiming the coach was unassigned.
-- The swap row survives the DELETE with requester_shift_id NULL (mig 603's
-- ON DELETE SET NULL), inside this same transaction.
--
-- ERRORS (all P0001, message prefix is the contract the route maps to 409):
--   swap_not_found, swap_not_open, swap_shift_missing, swap_stale,
--   swap_same_block (reciprocal only), swap_conflict (reciprocal + reassign).
--
-- SECURITY: SECURITY INVOKER, search_path pinned empty, every name
-- schema-qualified. EXECUTE only for service_role (the route's client);
-- revoked from PUBLIC/anon/authenticated, mig 496 posture.
--
-- APPLY: before the SWAPS.2 route deploys (the new route calls the two new
-- functions; the old route never calls them, so applying early is safe).
-- AFTER APPLYING: get_advisors (type=security).

-- ─────────────────────────────────────────────────────────────────────────
-- Reciprocal swap: mig 612's body, with the adjustments cleared on the move.
-- ─────────────────────────────────────────────────────────────────────────
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
  --    SWAPS.2 (mig 615) — the previous coach's paid-window override, its
  --    reason and their arrival stamp do not travel with the shift: the new
  --    coach works the block's times.
  v_prev_allow := COALESCE(current_setting('app.allow_overlap', true), '');
  PERFORM set_config('app.allow_overlap', 'on', true);

  UPDATE public.shift_assignments AS sa
     SET profile_id          = CASE sa.id WHEN v_req.id THEN v_tgt.profile_id ELSE v_req.profile_id END,
         status              = 'swapped',
         start_time_override = NULL,
         end_time_override   = NULL,
         partial_reason      = NULL,
         arrived_at          = NULL,
         arrival_source      = NULL
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

-- ─────────────────────────────────────────────────────────────────────────
-- Reassign: the requester's shift goes to the taker (swap.target_id).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_reassign_shift_swap(
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
  v_swap public.shift_swap_requests;
  v_req  public.shift_assignments;
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
  IF v_swap.requester_shift_id IS NULL THEN
    RAISE EXCEPTION 'swap_shift_missing: the requester''s shift no longer exists';
  END IF;

  -- 2. Lock and read the assignment.
  SELECT * INTO v_req
    FROM public.shift_assignments
   WHERE id = v_swap.requester_shift_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swap_shift_missing: the requester''s shift no longer exists';
  END IF;

  -- 3. Still the swap the caller judged: the shift still belongs to the
  --    requester it read, the swap still names the taker it read (a
  --    withdraw + re-claim by someone else must not hand the shift to a coach
  --    the manager never saw), and it is still a reassign, not a reciprocal.
  IF p_requester_profile IS NULL OR p_target_profile IS NULL
     OR v_req.profile_id IS DISTINCT FROM p_requester_profile
     OR v_swap.target_id IS DISTINCT FROM p_target_profile
     OR v_swap.target_shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'swap_stale: this shift or its taker has changed since the swap was requested';
  END IF;

  -- 4. The taker must not already hold a row on this block — the final state
  --    would duplicate (block, coach) on the mig 067 unique key. Checked
  --    first so the answer is a clean swap_conflict, not a raw 23505. Also
  --    covers a taker equal to the requester (their own row is on the block).
  IF EXISTS (
    SELECT 1 FROM public.shift_assignments a
     WHERE a.block_id = v_req.block_id
       AND a.profile_id = p_target_profile
  ) THEN
    RAISE EXCEPTION 'swap_conflict: the coach taking this shift is already on its block';
  END IF;

  -- 5. Move the row and clear the previous coach's adjustments (mig 615
  --    header). One row, one statement: the overlap guard's single firing
  --    judges the final state, so no escape hatch is needed.
  UPDATE public.shift_assignments AS sa
     SET profile_id          = p_target_profile,
         status              = 'swapped',
         start_time_override = NULL,
         end_time_override   = NULL,
         partial_reason      = NULL,
         arrived_at          = NULL,
         arrival_source      = NULL
   WHERE sa.id = v_req.id;

  -- 6. Approve the swap row last, in the same transaction.
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

COMMENT ON FUNCTION public.approve_reassign_shift_swap(uuid, uuid, timestamptz, text, uuid, uuid) IS
  'SWAPS.2 (mig 615) — approves a reassign swap atomically: locks the swap + the requester''s assignment, verifies requester and taker are unchanged, moves the row to the taker (status swapped, overrides and arrival stamp cleared) and stamps the swap approved, in one transaction. Errors are P0001 with a swap_* message prefix. service_role only.';

REVOKE ALL ON FUNCTION public.approve_reassign_shift_swap(uuid, uuid, timestamptz, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_reassign_shift_swap(uuid, uuid, timestamptz, text, uuid, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Drop: the requester's shift is deleted (ROSTER-FIX.1 D4 — never tombstoned).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_drop_shift_swap(
  p_swap_id           uuid,
  p_reviewed_by       uuid,
  p_reviewed_at       timestamptz,
  p_review_note       text,
  p_requester_profile uuid
)
RETURNS public.shift_swap_requests
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_swap public.shift_swap_requests;
  v_req  public.shift_assignments;
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
  IF v_swap.requester_shift_id IS NULL THEN
    RAISE EXCEPTION 'swap_shift_missing: the requester''s shift no longer exists';
  END IF;

  -- 2. Lock and read the assignment.
  SELECT * INTO v_req
    FROM public.shift_assignments
   WHERE id = v_swap.requester_shift_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swap_shift_missing: the requester''s shift no longer exists';
  END IF;

  -- 3. Still the drop the caller judged: the shift still belongs to the
  --    requester it read, and nobody has claimed or been named since.
  IF p_requester_profile IS NULL
     OR v_req.profile_id IS DISTINCT FROM p_requester_profile
     OR v_swap.target_id IS NOT NULL
     OR v_swap.target_shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'swap_stale: this shift or its taker has changed since the swap was requested';
  END IF;

  -- 4. Delete the assignment (the overlap guard does not fire on DELETE). The
  --    swap row's requester_shift_id goes NULL via mig 603's ON DELETE SET
  --    NULL, in this transaction.
  DELETE FROM public.shift_assignments AS sa
   WHERE sa.id = v_req.id;

  -- 5. Approve the swap row last, in the same transaction.
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

COMMENT ON FUNCTION public.approve_drop_shift_swap(uuid, uuid, timestamptz, text, uuid) IS
  'SWAPS.2 (mig 615) — approves a drop swap atomically: locks the swap + the requester''s assignment, verifies it is still the requester''s and still unclaimed, deletes the assignment and stamps the swap approved, in one transaction. Errors are P0001 with a swap_* message prefix. service_role only.';

REVOKE ALL ON FUNCTION public.approve_drop_shift_swap(uuid, uuid, timestamptz, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_drop_shift_swap(uuid, uuid, timestamptz, text, uuid) TO service_role;
