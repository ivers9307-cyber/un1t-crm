-- SPEND.P3 — company-card receipts.
--
-- A standalone, per-receipt spend-capture flow distinct from FTE
-- expense claims (which are monthly, reimburse-the-staff-member) and
-- contractor invoices (monthly, pay-the-contractor). A company-card
-- receipt is: "the company already paid on its card; here is the
-- receipt that needs allocating in Xero." One row per purchase — snap
-- it as you spend, no monthly batching.
--
-- Permission-gated SUBMISSION (the `card_receipts` permission — only
-- card holders), owner/master APPROVAL (same as the other spend
-- types), then it rides the existing invoices_queue → bookkeeper →
-- Xero machinery (mig 185). No new Xero integration: on approval a
-- row drops into invoices_queue with source_type='card_receipt' and
-- the bookkeeper signs it off in /invoices exactly like every other
-- spend type.
--
-- Status flow: submitted → awaiting_accountant_review (owner approves
-- → enqueue) | declined (owner, with reason) | revoked (submitter).
-- Mirrors contractor_invoices' shape (mig 101 + 185).
--
-- Receipt file lives in the private 'company-card-receipts' bucket;
-- the path is held on the row, clients fetch a 5-min signed URL via
-- /api/card-receipts/[id]/receipt. PDF or photo (SPEND.P1's receipt
-- types) — magic-byte verified on finalise.

set check_function_bodies = off;

-- ====================================================================
-- 1. card_receipts table
-- ====================================================================

create table if not exists public.card_receipts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete restrict,
  submitter_id uuid not null references public.profiles(id) on delete cascade,
  purchase_date date not null,
  amount numeric(10, 2) not null check (amount > 0),
  vat_amount numeric(10, 2) not null default 0
    check (vat_amount >= 0 and vat_amount <= amount),
  merchant text check (merchant is null or length(merchant) <= 200),
  description text check (description is null or length(description) <= 500),
  -- Optional last-4 of the card so the bookkeeper can match the row to
  -- the right card transaction in Xero's bank feed.
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  receipt_path text not null,
  receipt_size_bytes int check (receipt_size_bytes is null or receipt_size_bytes > 0),
  receipt_mime_type text check (receipt_mime_type is null or length(receipt_mime_type) <= 100),
  status text not null default 'submitted'
    check (status in ('submitted', 'awaiting_accountant_review', 'declined', 'revoked')),
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  approved_at timestamptz,
  declined_at timestamptz,
  revoked_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) <= 1000),
  notes text check (notes is null or length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists card_receipts_touch on public.card_receipts;
create trigger card_receipts_touch
  before update on public.card_receipts
  for each row execute function public.update_updated_at();

-- Approver queue: pending submissions at a location, newest first.
create index if not exists card_receipts_review_queue_idx
  on public.card_receipts (location_id, status, submitted_at desc)
  where status = 'submitted';

-- Submitter history.
create index if not exists card_receipts_by_submitter_idx
  on public.card_receipts (submitter_id, submitted_at desc);

-- RLS: all access is through the service-role API (createServerClient)
-- with application-layer auth gates — same posture as contractor
-- invoices (money data, no direct browser/mobile reads). Enable RLS
-- with no authenticated policy = deny-all for authenticated/anon; the
-- service role bypasses it. The signed-upload token (not the
-- authenticated role) authorises the direct-to-storage receipt upload.
alter table public.card_receipts enable row level security;

comment on table public.card_receipts is
  'SPEND.P3 — company-card receipts. Per-purchase spend capture: card already paid, receipt needs allocating in Xero. Submission gated by the card_receipts permission; owner/master approves; on approval an invoices_queue row (source_type=card_receipt) carries it to the bookkeeper → Xero leg. Receipt file in the private company-card-receipts storage bucket. Service-role-only (RLS deny-all for authenticated).';

comment on column public.card_receipts.status is
  'submitted | awaiting_accountant_review (owner approved → enqueued for bookkeeper) | declined | revoked.';

-- ====================================================================
-- 2. Private storage bucket
-- ====================================================================

insert into storage.buckets (id, name, public)
values ('company-card-receipts', 'company-card-receipts', false)
on conflict (id) do nothing;

do $$
begin
  drop policy if exists "deny all on company-card-receipts" on storage.objects;
exception when others then null;
end $$;

create policy "deny all on company-card-receipts"
  on storage.objects
  for all
  to authenticated, anon
  using (bucket_id <> 'company-card-receipts')
  with check (bucket_id <> 'company-card-receipts');

-- ====================================================================
-- 3. Extend invoices_queue for the new source type (mig 185)
-- ====================================================================
--
-- A card receipt joins the existing polymorphic queue: a 5th
-- source_type, a 5th per-source FK, and the XOR check rewritten to
-- include it. The bookkeeper → Xero code (push-xero.js) is blind to
-- source_type — it reads extracted_fields + the bookkeeper-picked Xero
-- refs — so no change is needed there.

alter table public.invoices_queue
  drop constraint if exists invoices_queue_source_type_check;
alter table public.invoices_queue
  add constraint invoices_queue_source_type_check
  check (source_type in (
    'supplier_email',
    'contractor_invoice',
    'fte_expense_item',
    'car_document',
    'card_receipt'
  ));

alter table public.invoices_queue
  add column if not exists source_card_receipt_id uuid
    references public.card_receipts(id) on delete cascade;

-- Rewrite the source XOR to add the card_receipt branch and the
-- `... is null` clause for the new column in every existing branch.
alter table public.invoices_queue
  drop constraint if exists invoices_queue_source_xor;
alter table public.invoices_queue
  add constraint invoices_queue_source_xor check (
    (source_type = 'supplier_email'
      and source_contractor_invoice_id is null
      and source_fte_expense_item_id is null
      and source_car_document_id is null
      and source_card_receipt_id is null)
    or
    (source_type = 'contractor_invoice'
      and source_contractor_invoice_id is not null
      and source_fte_expense_item_id is null
      and source_car_document_id is null
      and source_card_receipt_id is null)
    or
    (source_type = 'fte_expense_item'
      and source_contractor_invoice_id is null
      and source_fte_expense_item_id is not null
      and source_car_document_id is null
      and source_card_receipt_id is null)
    or
    (source_type = 'car_document'
      and source_contractor_invoice_id is null
      and source_fte_expense_item_id is null
      and source_car_document_id is not null
      and source_card_receipt_id is null)
    or
    (source_type = 'card_receipt'
      and source_contractor_invoice_id is null
      and source_fte_expense_item_id is null
      and source_car_document_id is null
      and source_card_receipt_id is not null)
  );

create index if not exists invoices_queue_source_card_receipt_idx
  on public.invoices_queue (source_card_receipt_id)
  where source_card_receipt_id is not null;

comment on column public.invoices_queue.attachment_bucket is
  'Supabase Storage bucket name. supplier_email = inbound-invoices; contractor_invoice = contractor-invoices; fte_expense_item = fte-expense-receipts; car_document = car-documents; card_receipt = company-card-receipts.';
