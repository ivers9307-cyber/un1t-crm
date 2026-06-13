-- SPEND.P3.1 — company-card receipts ride the emailed-invoice path.
--
-- Correction to mig 266: a card receipt should behave like an inbound
-- supplier invoice, NOT like a contractor invoice. The submitter just
-- provides the receipt photo; the bookkeeper's Analyse (Claude Vision
-- OCR) fills amount / merchant / date / VAT inside /invoices, exactly
-- like an emailed invoice. So those fields are no longer collected at
-- intake — relax their NOT NULL constraints so a row can be inserted
-- with just the photo (+ optional card last-4 + note).
--
-- The owner approve/decline step (mig 266 / the approvals provider) is
-- removed in the same change set: the receipt auto-enqueues to
-- invoices_queue on submit (status 'received', source_type
-- 'card_receipt') and the bookkeeper's queue review IS the approval —
-- same as a supplier email. No schema change needed for that part
-- (the source_type + FK from mig 266 stay); this migration only
-- relaxes the now-unused intake columns.
--
-- amount keeps its `> 0` CHECK (a NULL passes the check — unknown), so
-- a bookkeeper-entered amount is still validated.

alter table public.card_receipts alter column amount drop not null;
alter table public.card_receipts alter column purchase_date drop not null;
alter table public.card_receipts alter column vat_amount drop not null;
alter table public.card_receipts alter column vat_amount drop default;

comment on column public.card_receipts.amount is
  'Filled by the bookkeeper from the OCR/Analyse in /invoices (the queue row''s extracted_fields is the source of truth). NULL at intake — the submitter only provides the photo.';
