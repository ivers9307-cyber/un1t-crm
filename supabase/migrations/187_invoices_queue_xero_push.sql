-- XERO-API.3 PR 3 — invoices_queue columns for the API push result.
--
-- Replaces the Postmark→Hubdoc email-to-bills loop with a direct
-- Xero /Invoices push. The push returns a structured response
-- (InvoiceID, InvoiceNumber, deep-link URL) which we persist onto
-- the queue row so the UI can link straight to the draft bill in
-- Xero.
--
-- We KEEP the existing xero_email_message_id / xero_synced_at /
-- forwarded_at columns. Historical rows that were forwarded via
-- the old Postmark path still have those populated and we want
-- the audit log + read-side queries to keep working unchanged.
-- New rows after this migration will have xero_bill_id populated
-- AND xero_email_message_id null — the UI branches on whichever
-- is present.
--
-- bills_email_address on xero_connections is intentionally NOT
-- dropped here even though we stop reading it. Two reasons:
--   1. Rollback insurance — if PR 3 needs to revert, we don't
--      lose every customer's painstakingly-pasted bills email.
--   2. The column is harmless if unused. We can drop it in a
--      follow-up cleanup migration once the new push has been
--      in production for a few weeks without issue.

set check_function_bodies = off;

alter table public.invoices_queue
  add column xero_bill_id text
    check (xero_bill_id is null or length(xero_bill_id) between 1 and 100),
  add column xero_bill_number text
    check (xero_bill_number is null or length(xero_bill_number) between 1 and 100),
  add column xero_deep_link_url text
    check (xero_deep_link_url is null or length(xero_deep_link_url) <= 500);

comment on column public.invoices_queue.xero_bill_id is
  'XERO-API.3 — Xero InvoiceID (uuid-shaped GUID) returned by /Invoices POST. NULL for historical rows that were forwarded via the Postmark email path (see xero_email_message_id).';

comment on column public.invoices_queue.xero_bill_number is
  'XERO-API.3 — Xero auto-assigned InvoiceNumber on the draft bill (e.g. INV-0001). Useful for the inbox UI to display alongside the deep-link button.';

comment on column public.invoices_queue.xero_deep_link_url is
  'XERO-API.3 — direct https://go.xero.com link to the draft bill, computed from tenant_id + InvoiceID. Surfaced as an "Open in Xero" button in the Forwarded tab.';

-- Optional index — most reads filter on status, but a few flows
-- (e.g. webhook reconciliation when Xero status changes upstream)
-- look rows up by xero_bill_id directly. Partial index keeps it
-- cheap.
create index invoices_queue_xero_bill_idx
  on public.invoices_queue (xero_bill_id)
  where xero_bill_id is not null;
