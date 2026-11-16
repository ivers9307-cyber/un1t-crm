-- 845_car_deposit_superseded_orders.sql
--
-- DEPOSITREISSUE.1 (15 Nov 2026 feature audit, step 2 item 14): a re-issued
-- car deposit link no longer orphans a payment on the old link.
--
-- NOT APPLIED YET when this file was written. Apply it BEFORE the
-- DEPOSITREISSUE.1 code deploys: re-issuing a link over a still-pending order
-- writes a row here first and refuses (503) when it cannot, so until this is
-- applied such a re-issue is refused rather than orphaning anything. Applying
-- it early changes nothing (an empty table nothing reads yet).
--
-- WHY
-- Re-issuing a deposit link rotated the token and cleared
-- cars.deposit_revolut_order_id, but the old Revolut order stayed open: a
-- buyer with the old page still open could pay it, and the Revolut webhook
-- and the reconcile both match a payment to a car ONLY by that column, so the
-- money arrived and the car never showed it paid.
--
-- WHAT
--   public.car_deposit_superseded_orders: one row per order a re-issue
--   replaced while it was still pending. The webhook and the reconcile match
--   an order here when no car holds it; a COMPLETED order marks the car paid
--   (and becomes its order of record); a cancelled/failed one is closed
--   without touching the car (the new link is still live). settled_at /
--   settled_state record which.
--   Service role only: RLS on, no policy, no client privilege (mig 677).
--
-- ROLLBACK: DROP TABLE public.car_deposit_superseded_orders; (revert the
--   DEPOSITREISSUE.1 code first).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.car_deposit_superseded_orders (
  order_id      text PRIMARY KEY,
  car_id        uuid NOT NULL REFERENCES public.cars(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL,
  superseded_at timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  settled_state text
);

CREATE INDEX IF NOT EXISTS car_deposit_superseded_orders_car_idx
  ON public.car_deposit_superseded_orders (car_id);
CREATE INDEX IF NOT EXISTS car_deposit_superseded_orders_open_idx
  ON public.car_deposit_superseded_orders (superseded_at) WHERE settled_at IS NULL;

COMMENT ON TABLE public.car_deposit_superseded_orders IS
  'DEPOSITREISSUE.1 (mig 845): Revolut deposit orders a re-issued link replaced while still pending. The Revolut webhook and reconcile settle them: completed -> the car is paid; cancelled/failed -> closed. Service role only.';

ALTER TABLE public.car_deposit_superseded_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.car_deposit_superseded_orders FROM anon, authenticated;

COMMIT;
