-- 371_vat_crosscheck.sql
-- RCOV.P2 / audit F2 — capture what Xero actually books as tax on the
-- created bill so it can be compared against the OCR-extracted VAT.
-- xero_tax_mismatch: null = not evaluated (pre-P2 rows / missing data),
-- false = corroborated, true = mismatch (surfaced in Exceptions tab).
alter table public.invoices_queue
  add column if not exists xero_total_tax numeric,
  add column if not exists xero_tax_mismatch boolean;

create index if not exists invoices_queue_tax_mismatch_idx
  on public.invoices_queue (location_id)
  where xero_tax_mismatch = true;
