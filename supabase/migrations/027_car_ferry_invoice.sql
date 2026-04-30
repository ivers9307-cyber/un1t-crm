-- ============================================================
-- 027: Add 'ferry_invoice' to the car_documents.doc_type CHECK
--      constraint. The Ferry cost was added as a numeric line in
--      migration 026; the corresponding invoice document type wasn't
--      part of v1's checklist. This migration retrofits it so the
--      operator can upload the ferry crossing invoice alongside the
--      other supporting paperwork.
--
-- Postgres won't let us ADD a value to a CHECK CONSTRAINT in place;
-- we drop and recreate. Existing rows still validate (they all
-- carry doc_types from the original list, all of which are kept).
-- ============================================================

ALTER TABLE car_documents
  DROP CONSTRAINT IF EXISTS car_documents_doc_type_check;

ALTER TABLE car_documents
  ADD CONSTRAINT car_documents_doc_type_check
  CHECK (doc_type IN (
    'nct_invoice',
    'irish_customs',
    'bca_invoice',
    'transporter',
    'ferry_invoice',
    'other'
  ));
