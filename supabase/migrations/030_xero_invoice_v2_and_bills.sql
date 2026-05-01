-- Xero v2 — extend cars + car_documents to support:
--   1. Invoice issue v2 (validation, email send, PDF saved to Storage,
--      void & reissue when sale price drifts)
--   2. Bills push — forwarding uploaded supplier docs to Xero's
--      Files Inbox so Xero auto-bill OCR turns them into draft bills

-- ── Cars ────────────────────────────────────────────────────────
ALTER TABLE cars ADD COLUMN IF NOT EXISTS xero_invoice_amount       NUMERIC(10,2);
ALTER TABLE cars ADD COLUMN IF NOT EXISTS xero_invoice_online_url   TEXT;
ALTER TABLE cars ADD COLUMN IF NOT EXISTS xero_invoice_pdf_path     TEXT;
ALTER TABLE cars ADD COLUMN IF NOT EXISTS xero_invoice_emailed_at   TIMESTAMPTZ;
ALTER TABLE cars ADD COLUMN IF NOT EXISTS xero_invoice_branding_id  TEXT;
ALTER TABLE cars ADD COLUMN IF NOT EXISTS xero_invoice_issue_count  INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN cars.xero_invoice_amount IS
  'IE ex-VAT amount we sent on the most recent Xero invoice. Used to detect drift between current sale price and the issued invoice.';
COMMENT ON COLUMN cars.xero_invoice_pdf_path IS
  'Supabase Storage key for the saved invoice PDF (private car-documents bucket).';
COMMENT ON COLUMN cars.xero_invoice_issue_count IS
  'Counter incremented on every successful invoice push (incl. reissue after void).';

-- ── Car documents ──────────────────────────────────────────────
ALTER TABLE car_documents ADD COLUMN IF NOT EXISTS xero_file_id    TEXT;
ALTER TABLE car_documents ADD COLUMN IF NOT EXISTS xero_sent_at    TIMESTAMPTZ;
ALTER TABLE car_documents ADD COLUMN IF NOT EXISTS xero_sent_by    UUID REFERENCES profiles(id);
ALTER TABLE car_documents ADD COLUMN IF NOT EXISTS xero_send_error TEXT;

COMMENT ON COLUMN car_documents.xero_file_id IS
  'Xero Files API id once forwarded. Auto-bill OCR creates a draft Bill in Xero from this file.';

CREATE INDEX IF NOT EXISTS car_documents_xero_file_idx ON car_documents(xero_file_id) WHERE xero_file_id IS NOT NULL;
