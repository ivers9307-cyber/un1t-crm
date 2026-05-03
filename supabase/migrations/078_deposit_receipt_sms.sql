-- Buyer-facing receipt SMS when a car deposit is paid (Revolut webhook
-- ORDER_COMPLETED). Two pieces:
--
--   1. cars.deposit_receipt_sent_at — idempotency stamp. The Revolut
--      webhook is documented as at-least-once delivery; without this
--      column we'd risk re-sending the receipt on every retry. Stamped
--      ONLY on a successful Twilio send so a transient failure can be
--      retried by the next webhook delivery (in practice rare since the
--      webhook always returns 200, but the semantic is the right one).
--
--   2. locations.car_deposit_receipt_sms_enabled — per-location toggle.
--      Each business unit (CCF Autos, future gym memberships, etc.)
--      opts in independently. Defaults to FALSE so a new location
--      doesn't accidentally start auto-sending SMS to customers; the
--      backfill below flips ON for any location that's currently
--      configured for car deposits at the time this migration runs
--      (i.e., CCF Autos), so the existing flow turns on automatically
--      without operator intervention.

ALTER TABLE cars
  ADD COLUMN IF NOT EXISTS deposit_receipt_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN cars.deposit_receipt_sent_at IS
  'Timestamp when the buyer received their deposit-paid receipt SMS. Used for idempotency in the Revolut webhook so duplicate ORDER_COMPLETED events do not re-send. NULL = receipt not yet sent (or buyer had no phone, or location toggle disabled, or send failed and we want a future webhook delivery to retry).';

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS car_deposit_receipt_sms_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN locations.car_deposit_receipt_sms_enabled IS
  'When TRUE, the Revolut webhook for ORDER_COMPLETED triggers a buyer-facing receipt SMS via Twilio (per src/lib/deposit-receipts.js). When FALSE, the webhook still flips the car to deposit_status=paid but no SMS is sent. Per-location so each business unit can opt in independently. Default FALSE (explicit opt-in) — the mig 078 backfill turned this ON for any location with car_deposit_default_amount IS NOT NULL at deploy time so CCF Autos picked it up automatically.';

-- Backfill: any location currently configured for car deposits gets
-- the receipt SMS auto-enabled. Future locations have to opt in
-- explicitly via Settings → Locations → Car deposit.
UPDATE locations
   SET car_deposit_receipt_sms_enabled = TRUE
 WHERE car_deposit_default_amount IS NOT NULL
   AND car_deposit_receipt_sms_enabled = FALSE;
