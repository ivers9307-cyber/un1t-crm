-- INVOICE-OCR.1 — Claude Vision-driven invoice extraction + Xero
-- draft-bill push, replacing the Dext-style outsourced OCR pipeline.
--
-- The existing flow (send-to-xero via bills-email.js) attaches the
-- raw PDF to Xero's email-in address and lets Xero/Hubdoc OCR on
-- their end. The new flow runs OCR in-house via Claude Vision,
-- shows the operator a review screen with editable fields, and
-- POSTs a structured draft Bill to Xero's Invoices API. The two
-- paths coexist on the car_document row — bills-email and api-push
-- are independent columns; whichever the operator triggers wins.
--
-- Columns:
--   extracted_invoice_fields  JSONB  — parsed result of the
--     Claude Vision call. Schema enforced by the validator in
--     src/lib/invoice-extraction.js (zod). Nullable until extract
--     is run; can be re-extracted (overwrites prior result).
--   extracted_at              TIMESTAMPTZ
--   extracted_by              UUID REFERENCES profiles(id)
--   review_status             TEXT — null | 'extracted' | 'reviewed' | 'pushed' | 'failed'
--                                    Drives the UI state machine on
--                                    DocumentsCard.jsx.
--   xero_bill_id              TEXT — Xero Invoice ID returned by the
--                                    POST /Invoices API (Type ACCPAY,
--                                    Status DRAFT). NOT the same as
--                                    xero_file_id which is the
--                                    Postmark message id from the
--                                    bills-email path.
--   xero_pushed_at            TIMESTAMPTZ
--   xero_pushed_by            UUID REFERENCES profiles(id)
--   xero_push_error           TEXT  — most recent failure reason.
--                                    Cleared on successful push.

ALTER TABLE public.car_documents
  ADD COLUMN IF NOT EXISTS extracted_invoice_fields JSONB,
  ADD COLUMN IF NOT EXISTS extracted_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extracted_by            UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_status           TEXT,
  ADD COLUMN IF NOT EXISTS xero_bill_id            TEXT,
  ADD COLUMN IF NOT EXISTS xero_pushed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS xero_pushed_by          UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS xero_push_error         TEXT;

-- Enum-like CHECK on review_status. Allow null for "never run".
ALTER TABLE public.car_documents
  DROP CONSTRAINT IF EXISTS car_documents_review_status_check;
ALTER TABLE public.car_documents
  ADD CONSTRAINT car_documents_review_status_check
  CHECK (review_status IS NULL OR review_status IN ('extracted', 'reviewed', 'pushed', 'failed'));

-- Index for the "show me docs ready to push to Xero" listing
-- (operator workflow: extract on upload, review later, push when
-- ready). Partial on non-null status keeps the index small.
CREATE INDEX IF NOT EXISTS idx_car_documents_review_status
  ON public.car_documents (review_status)
  WHERE review_status IS NOT NULL;

COMMENT ON COLUMN public.car_documents.extracted_invoice_fields IS
  'INVOICE-OCR.1 — JSON shape: { supplier_name, supplier_address?, invoice_number, invoice_date (ISO date), due_date? (ISO date), currency (ISO 4217), subtotal, tax_amount, total, line_items: [{ description, quantity, unit_amount, account_code? }] }. Enforced by src/lib/invoice-extraction.js.';
COMMENT ON COLUMN public.car_documents.xero_bill_id IS
  'INVOICE-OCR.1 — Xero Invoice ID (Type=ACCPAY, Status=DRAFT) returned by the API push. NOT the Postmark message id used by xero_file_id (bills-email path).';
