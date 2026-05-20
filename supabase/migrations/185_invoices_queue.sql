-- INVOICES-QUEUE.1 — restructure approval-to-Xero flow (PR 1 of 3).
--
-- Repurposes the INVOICES.1 inbound_invoices table into a unified
-- "invoices queue" — the centralised accountant sign-off surface
-- that everything Xero-bound now funnels through.
--
-- Three things happen here:
--   1. Rename inbound_invoices → invoices_queue.
--   2. Add a polymorphic source discriminator (source_type) +
--      per-source nullable FK columns so a queue row knows which
--      originating row to point back at (contractor invoice / FTE
--      expense item / car document; supplier emails ARE the source).
--      Per-source FKs (not a single polymorphic ref) so ON DELETE
--      CASCADE actually works — Postgres has no native polymorphic
--      FK story.
--   3. Add the new `awaiting_accountant_review` status to
--      fte_expense_claims and contractor_invoices. Submitter sees
--      "approved by your manager, awaiting accountant sign-off
--      before forwarding to Xero" — terminal from THEIR point of
--      view; bookkeeper's job from here.
--
-- PR 2 of this series will add the bulk operations UI inside
-- /invoices and the bookkeeper-gated send-to-Xero action.
-- PR 3 will centralise the Claude Vision OCR (today still split
-- per-feature) so there is exactly one place extraction runs from.

set check_function_bodies = off;

-- ====================================================================
-- 1. Rename inbound_invoices → invoices_queue
-- ====================================================================
--
-- The INVOICES.1 table (mig 184) was already shaped like the unified
-- queue we want; we just need to widen the source assumption. Rename
-- before adding columns so the new columns land on the renamed table
-- and the indexes / trigger / constraint names follow the rename
-- explicitly below (Postgres renames the table but leaves attached
-- objects on their original names — we tidy them so a future reader
-- doesn't grep for the old name and miss things).

alter table public.inbound_invoices rename to invoices_queue;

-- Indexes — rename so `\d invoices_queue` shows sensible names.
alter index if exists inbound_invoices_pkey
  rename to invoices_queue_pkey;
alter index if exists inbound_invoices_email_message_id_key
  rename to invoices_queue_email_message_id_key;
alter index if exists inbound_invoices_inbox_idx
  rename to invoices_queue_inbox_idx;
alter index if exists inbound_invoices_received_idx
  rename to invoices_queue_received_idx;
alter index if exists inbound_invoices_status_idx
  rename to invoices_queue_status_idx;

-- Constraints — rename so error messages reference the new table.
alter table public.invoices_queue
  rename constraint inbound_invoices_status_check to invoices_queue_status_check;
-- (FK to locations + profiles auto-rename in PG14+; the name will be
--  inbound_invoices_location_id_fkey etc, leaving them is harmless
--  but we rename for tidiness.)
do $$
declare
  c record;
  new_name text;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.invoices_queue'::regclass
       and conname like 'inbound_invoices_%'
  loop
    new_name := replace(c.conname, 'inbound_invoices_', 'invoices_queue_');
    execute format('alter table public.invoices_queue rename constraint %I to %I',
                   c.conname, new_name);
  end loop;
end $$;

-- Trigger — rename to match.
alter trigger inbound_invoices_updated_at on public.invoices_queue
  rename to invoices_queue_updated_at;

-- Trigger function — leave its name as inbound_invoices_touch_updated_at
-- because renaming would orphan any other reference; instead create a
-- new function with the queue-shaped name and re-point the trigger,
-- then drop the old one.
create or replace function public.invoices_queue_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger invoices_queue_updated_at on public.invoices_queue;
create trigger invoices_queue_updated_at
  before update on public.invoices_queue
  for each row execute function public.invoices_queue_touch_updated_at();

drop function if exists public.inbound_invoices_touch_updated_at();

-- ====================================================================
-- 2. Source discriminator + per-source FK columns
-- ====================================================================

alter table public.invoices_queue
  add column source_type text not null default 'supplier_email'
    check (source_type in (
      'supplier_email',
      'contractor_invoice',
      'fte_expense_item',
      'car_document'
    ));

-- Drop the default so future inserts must declare a source explicitly.
-- (Existing rows have already been backfilled by the default at ADD.)
alter table public.invoices_queue alter column source_type drop default;

-- Per-source FKs. Nullable because exactly ONE is populated per row
-- (the others stay NULL); for source_type='supplier_email' ALL are
-- NULL (the queue row IS the source-of-record for that ingest).
--
-- ON DELETE CASCADE so deleting the originating row removes the queue
-- entry too — the source is the system-of-record for the financial
-- document, the queue is just where it waits for accountant sign-off.
alter table public.invoices_queue
  add column source_contractor_invoice_id uuid
    references public.contractor_invoices(id) on delete cascade;
alter table public.invoices_queue
  add column source_fte_expense_item_id uuid
    references public.fte_expense_items(id) on delete cascade;
alter table public.invoices_queue
  add column source_car_document_id uuid
    references public.car_documents(id) on delete cascade;

-- Belt-and-braces — the application layer should set exactly one
-- source FK based on source_type. Add a CHECK that enforces it so a
-- bad insert can't escape into the queue silently.
alter table public.invoices_queue
  add constraint invoices_queue_source_xor check (
    (source_type = 'supplier_email'
      and source_contractor_invoice_id is null
      and source_fte_expense_item_id is null
      and source_car_document_id is null)
    or
    (source_type = 'contractor_invoice'
      and source_contractor_invoice_id is not null
      and source_fte_expense_item_id is null
      and source_car_document_id is null)
    or
    (source_type = 'fte_expense_item'
      and source_contractor_invoice_id is null
      and source_fte_expense_item_id is not null
      and source_car_document_id is null)
    or
    (source_type = 'car_document'
      and source_contractor_invoice_id is null
      and source_fte_expense_item_id is null
      and source_car_document_id is not null)
  );

-- attachment_bucket — supplier_email attachments live in the
-- 'inbound-invoices' bucket (mig 184); contractor invoices live in
-- 'contractor-invoices'; FTE receipts in 'fte-expense-receipts'; car
-- documents in 'car-documents'. Storing the bucket per-row keeps the
-- queue code agnostic of where the original PDF physically sits.
alter table public.invoices_queue
  add column attachment_bucket text not null default 'inbound-invoices'
    check (length(attachment_bucket) between 1 and 100);
alter table public.invoices_queue alter column attachment_bucket drop default;

-- New shape-aware indexes. The existing (location_id, status,
-- received_at desc) inbox_idx stays useful for the supplier_email
-- view; this new one supports per-source-type queries the bulk UI
-- in PR 2 will run.
create index invoices_queue_source_idx
  on public.invoices_queue (source_type, status, received_at desc);

create index invoices_queue_source_contractor_idx
  on public.invoices_queue (source_contractor_invoice_id)
  where source_contractor_invoice_id is not null;
create index invoices_queue_source_fte_idx
  on public.invoices_queue (source_fte_expense_item_id)
  where source_fte_expense_item_id is not null;
create index invoices_queue_source_car_idx
  on public.invoices_queue (source_car_document_id)
  where source_car_document_id is not null;

comment on table public.invoices_queue is
  'INVOICES-QUEUE.1 — central accountant sign-off queue. Owner approval at the source feature drops a row in here; bookkeeper analyses + reviews + forwards to Xero from /invoices. Renamed from inbound_invoices (mig 184) in mig 185 when the table widened beyond supplier emails.';

comment on column public.invoices_queue.source_type is
  'INVOICES-QUEUE.1 — discriminator. Exactly one of source_contractor_invoice_id / source_fte_expense_item_id / source_car_document_id is populated; supplier_email rows have all three NULL (the queue row IS the source-of-record).';

comment on column public.invoices_queue.attachment_bucket is
  'Supabase Storage bucket name. supplier_email = inbound-invoices; contractor_invoice = contractor-invoices; fte_expense_item = fte-expense-receipts; car_document = car-documents.';

-- ====================================================================
-- 3. Add 'awaiting_accountant_review' status to FTE + contractor
-- ====================================================================
--
-- This is the new terminal-from-the-submitter's-POV state. Owner has
-- approved; submitter sees "Awaiting accountant sign-off before
-- forwarding to Xero" and has no further action. Bookkeeper does the
-- final review in /invoices.

alter table public.fte_expense_claims
  drop constraint fte_expense_claims_status_check;
alter table public.fte_expense_claims
  add constraint fte_expense_claims_status_check
  check (status in (
    'draft',
    'submitted',
    'approved',
    'awaiting_accountant_review',
    'declined',
    'revoked'
  ));

alter table public.contractor_invoices
  drop constraint contractor_invoices_status_check;
alter table public.contractor_invoices
  add constraint contractor_invoices_status_check
  check (status in (
    'submitted',
    'approved',
    'awaiting_accountant_review',
    'declined',
    'revoked'
  ));

comment on column public.fte_expense_claims.status is
  'draft | submitted | approved | awaiting_accountant_review | declined | revoked. INVOICES-QUEUE.1 added awaiting_accountant_review — owner has approved, bookkeeper now needs to sign off in /invoices before Xero forward.';

comment on column public.contractor_invoices.status is
  'submitted | approved | awaiting_accountant_review | declined | revoked. INVOICES-QUEUE.1 added awaiting_accountant_review — owner has approved, bookkeeper now needs to sign off in /invoices before Xero forward.';
