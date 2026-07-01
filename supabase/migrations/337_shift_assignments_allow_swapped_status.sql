-- 337 — Fix shift-swap approval: allow 'swapped' on shift_assignments.status.
--
-- BUG: a manager approving a reciprocal swap or a reassign hit
-- "new row for relation shift_assignments violates check constraint
-- shift_assignments_status_check". src/lib/swap-lifecycle.js writes
-- status='swapped' onto the affected assignment(s) on approval, but the
-- mig 067 CHECK only permitted scheduled/confirmed/completed/cancelled.
-- Every swap + reassign approval 500'd; only the 'drop' path (which
-- writes 'cancelled') worked.
--
-- 'swapped' was a documented status on the legacy public.shifts table
-- (mig 010, dropped in mig 238) but the roster-v2 shift_assignments
-- constraint never carried it forward. The resolver + its unit tests
-- already expect 'swapped', so widening the constraint is the whole fix
-- — the code is already live, no code deploy to coordinate.

ALTER TABLE public.shift_assignments
  DROP CONSTRAINT IF EXISTS shift_assignments_status_check;

ALTER TABLE public.shift_assignments
  ADD CONSTRAINT shift_assignments_status_check
  CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'swapped'));
