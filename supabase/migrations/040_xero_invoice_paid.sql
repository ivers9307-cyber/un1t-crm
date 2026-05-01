-- Track when a Xero customer invoice has been paid back to us.
-- Populated by Xero's "INVOICE.UPDATED" webhook (see
-- /api/webhooks/xero) — every status transition fires the hook;
-- we only care when Status flips to PAID. The car detail page
-- shows a green "Paid" badge once paid_at is non-null.

ALTER TABLE cars
  ADD COLUMN IF NOT EXISTS xero_invoice_paid_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS xero_invoice_amount_paid  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS xero_invoice_status       TEXT;

COMMENT ON COLUMN cars.xero_invoice_paid_at IS
  'Set when Xero notifies the customer invoice transitioned to Status=PAID.';
COMMENT ON COLUMN cars.xero_invoice_amount_paid IS
  'AmountPaid from the Xero webhook payload at the time of paid_at.';
COMMENT ON COLUMN cars.xero_invoice_status IS
  'Last-seen Xero invoice status (DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED).';

CREATE INDEX IF NOT EXISTS cars_xero_invoice_id_idx
  ON cars(xero_invoice_id) WHERE xero_invoice_id IS NOT NULL;
