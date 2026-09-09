-- ROSTER-FIX.2 — shift_swap_requests.status had no CHECK while the lifecycle
-- (src/lib/swap-lifecycle.js) uses five states; and nothing stopped two open
-- swaps on the same shift. Both enforced here.
--
-- PRE-APPLY DATA CHECKS (run read-only BEFORE applying this file; if either
-- returns anything unexpected, fix the data by hand — cancel the older
-- duplicate — before applying):
--
--   SELECT status, count(*) FROM shift_swap_requests GROUP BY 1;
--     Expected: only 'pending', 'awaiting_approval', 'approved', 'rejected',
--     'cancelled'. Any other value fails the ADD CONSTRAINT.
--
--   SELECT requester_shift_id, count(*) FROM shift_swap_requests
--    WHERE status IN ('pending','awaiting_approval')
--    GROUP BY 1 HAVING count(*) > 1;
--     Expected: zero rows. Any row fails the unique index.

ALTER TABLE public.shift_swap_requests
  DROP CONSTRAINT IF EXISTS shift_swap_requests_status_check;
ALTER TABLE public.shift_swap_requests
  ADD CONSTRAINT shift_swap_requests_status_check
  CHECK (status IN ('pending', 'awaiting_approval', 'approved', 'rejected', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS shift_swap_requests_one_open_per_shift
  ON public.shift_swap_requests (requester_shift_id)
  WHERE status IN ('pending', 'awaiting_approval');
