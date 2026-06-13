-- ============================================================
-- 268: orders — add 'cancelled' status (ORDERS-CANCEL.1)
--
-- Operators need to clear out PENDING orders that are clutter — e.g. a
-- buyer with several pending payment attempts who in fact already holds
-- a confirmed (completed) spot on the day. 'cancelled' is an explicit
-- operator dismissal, distinct from buyer-`abandoned` (the buyer ghosted
-- the checkout).
--
-- Why a distinct status rather than reusing 'abandoned': the retargeting
-- tag engine (src/lib/contact-events.js) keys the `race_registered_no_
-- payment` tag off the `order.abandoned` contact_event. An operator
-- clearing a confirmed buyer's duplicate must NOT trip that tag. The
-- cancel route (POST /api/orders/[id]/cancel) sets this status and
-- cascades the source row to its own terminal state
-- (race_payments→abandoned, cars.deposit_status→cancelled) WITHOUT
-- emitting any contact_event, so the tag engine is never fed.
-- ============================================================

BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'abandoned', 'refunded', 'recovered', 'cancelled'));

COMMENT ON COLUMN orders.status IS
  'pending → (completed | failed | abandoned | refunded). recovered is derived — set when a failed/abandoned order is superseded by a later completed one (same buyer email, same source_type, within RETRY_WINDOW_DAYS = 7 in src/lib/orders.js). cancelled is operator-initiated dismissal of a PENDING order (ORDERS-CANCEL.1, mig 268) — distinct from buyer-abandoned and deliberately NOT wired to the retargeting tag engine.';

COMMIT;
