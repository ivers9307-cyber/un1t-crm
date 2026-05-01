-- Per-org Xero bills email-in address. Each Xero org has a unique
-- email under Bills to pay → Create bill from email — PDFs sent
-- there are auto-OCR'd into draft Bills. Set once per location;
-- the "Send to Xero" button posts the doc to this address via
-- Postmark instead of via the Files API.

ALTER TABLE xero_connections ADD COLUMN IF NOT EXISTS bills_email_address TEXT;

COMMENT ON COLUMN xero_connections.bills_email_address IS
  'Per-org Xero email-to-bills forwarding address. Found in Xero UI under Bills to pay → Create bill from email. Set once per location to enable the document → draft bill auto-forward.';
