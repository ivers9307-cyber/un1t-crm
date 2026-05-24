-- XERO-WEBHOOK.1 — supplier-bill payment status on the invoice queue.
--
-- The CRM pushes each ingested supplier invoice to Xero as a draft
-- ACCPAY bill and then forgets it. Xero's Invoices webhook lets the
-- CRM learn the outcome: when the bookkeeper reconciles the bank
-- line against that bill, Xero flips the bill to PAID and fires an
-- INVOICE/UPDATE event. These columns hold that synced-back state so
-- the /invoices inbox can show "Paid · <date>" instead of a flat
-- "Sent to Xero".
--
-- Naming mirrors the existing xero_bill_* columns on this table
-- (xero_bill_id / xero_bill_number from mig 187). The equivalent
-- fields for CCF Autos customer invoices already live on `cars`
-- (xero_invoice_status / xero_invoice_paid_at) — same webhook, two
-- destinations.

alter table public.invoices_queue
  add column if not exists xero_bill_status            text,
  add column if not exists xero_bill_amount_paid       numeric,
  add column if not exists xero_bill_amount_due        numeric,
  add column if not exists xero_bill_paid_at           timestamptz,
  add column if not exists xero_bill_status_synced_at  timestamptz;

comment on column public.invoices_queue.xero_bill_status is
  'XERO-WEBHOOK.1 — the Xero invoice Status last seen via webhook (DRAFT | SUBMITTED | AUTHORISED | PAID | VOIDED | DELETED). NULL until the first webhook event.';
comment on column public.invoices_queue.xero_bill_paid_at is
  'XERO-WEBHOOK.1 — Xero FullyPaidOnDate when the bill reached PAID (falls back to the event time if Xero omits it). Cleared if the bill is later voided.';
comment on column public.invoices_queue.xero_bill_status_synced_at is
  'XERO-WEBHOOK.1 — when the Xero webhook last refreshed the payment fields on this row.';

-- Reverse lookup — the webhook matches an event's resourceId against
-- xero_bill_id to find the row to update.
create index if not exists invoices_queue_xero_bill_id_idx
  on public.invoices_queue (xero_bill_id)
  where xero_bill_id is not null;
