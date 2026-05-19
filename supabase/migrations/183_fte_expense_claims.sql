-- FTE-EXPENSES.1 — monthly expense reimbursement claims for FTE
-- staff.
--
-- Mirrors the structure of contractor_invoices (mig 101) but with a
-- header + items model rather than a single document, because FTE
-- reimbursement is typically many small receipts batched at month-
-- end (vs contractors who submit one service invoice for the period).
--
-- One claim = one month's expenses for one employee at one location.
-- Inside, many line items — each one receipt with its own date,
-- category, amount, VAT, vendor, and receipt photo / PDF.
--
-- Lifecycle: draft → submitted → {approved, declined, revoked}.
-- - draft is staff-editable: add/remove items, change period.
-- - submitted locks editing; only approve/decline/revoke transitions.
-- - approved triggers a Xero forward (email-to-bills, same path as
--   contractor invoices) in the submitter's name. Reimbursement is
--   reconciled on the next month's payroll outside the CRM.
-- - declined keeps the row for history; staff can submit a new claim
--   for the same period.
-- - revoked is self-only and only valid while submitted (staff
--   spotted a mistake before approval).
--
-- Approval gate: master OR owner-at-location. Same as contractor
-- invoices. No head-coach approval — these are reimbursements out of
-- company funds and the owner needs the sign-off authority.

set check_function_bodies = off;

-- ====================================================================
-- Header table — one row per (employee, location, month)
-- ====================================================================

create table public.fte_expense_claims (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid not null references public.profiles (id) on delete cascade,
  location_id         uuid not null references public.locations (id) on delete restrict,

  -- Period — calendar month. period_start is always day 1; period_end
  -- is the last day of the month. Both are stamped from a single
  -- YYYY-MM input at the API layer so the DB never has half-month
  -- ranges.
  period_start        date not null,
  period_end          date not null,
  check (period_end > period_start),
  check (date_trunc('month', period_start)::date = period_start),

  -- Cached totals. Updated by trigger when items change so the list
  -- view can render without recomputing per-row.
  total_amount        numeric(12, 2) not null default 0 check (total_amount >= 0),
  total_vat_amount    numeric(12, 2) not null default 0 check (total_vat_amount >= 0),
  item_count          int not null default 0 check (item_count >= 0),

  -- Status. The transition rules are enforced in the API layer (see
  -- /api/expenses/[id]/{submit,approve,decline,revoke}) rather than
  -- a DB trigger, because the legal-next-state set depends on the
  -- caller (only the submitter can revoke; only master/owner can
  -- approve/decline).
  status              text not null default 'draft'
                      check (status in ('draft', 'submitted', 'approved', 'declined', 'revoked')),

  -- Audit timestamps. Set as the row moves through states. Each is
  -- nullable until that state is reached.
  submitted_at        timestamptz,
  reviewed_at         timestamptz,
  reviewed_by         uuid references public.profiles (id) on delete set null,
  approved_at         timestamptz,
  declined_at         timestamptz,
  revoked_at          timestamptz,

  -- Decline reason — required on decline (enforced API-side), max
  -- 1000 chars to stop pathological payloads.
  decline_reason      text check (decline_reason is null or length(decline_reason) <= 1000),

  -- Free-text notes from the submitter for the approver. e.g. "first
  -- two are from the Berlin trip, the rest are office supplies".
  notes               text check (notes is null or length(notes) <= 2000),

  -- Xero forward state. Same pattern as contractor_invoices —
  -- approval triggers a Postmark send to the location's
  -- xero_connections.bills_email_address with each item's receipt
  -- attached. Stores Postmark messageId for traceability.
  xero_email_message_id text,
  xero_synced_at      timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One ACTIVE claim per (profile, location, period). 'active' means
-- not declined and not revoked — once those terminal-but-recoverable
-- states are reached, the employee can submit a fresh claim for the
-- same period. Partial unique index handles this without needing a
-- DB-level trigger.
create unique index fte_expense_claims_active_period_uidx
  on public.fte_expense_claims (profile_id, location_id, period_start)
  where status not in ('declined', 'revoked');

-- Filter-shaped indexes for the two hot queries:
--   1. approver review queue: WHERE location_id = ? AND status = 'submitted'
--   2. employee history:      WHERE profile_id = ? ORDER BY period_start DESC
create index fte_expense_claims_review_queue_idx
  on public.fte_expense_claims (location_id, status, submitted_at desc)
  where status = 'submitted';
create index fte_expense_claims_employee_history_idx
  on public.fte_expense_claims (profile_id, period_start desc);

comment on table  public.fte_expense_claims is
  'FTE-EXPENSES.1 — monthly expense reimbursement claims. Header for fte_expense_items. Mirrors contractor_invoices but with line items + VAT capture.';
comment on column public.fte_expense_claims.status is
  'draft | submitted | approved | declined | revoked. Transitions API-enforced, not DB-trigger-enforced, because legal-next-state depends on caller identity.';
comment on column public.fte_expense_claims.xero_email_message_id is
  'Postmark messageId from the bills-email forward on approval. NULL until approved (or if forward failed — caller logs a warning).';

-- ====================================================================
-- Items table — one row per receipt
-- ====================================================================

create table public.fte_expense_items (
  id                  uuid primary key default gen_random_uuid(),
  claim_id            uuid not null references public.fte_expense_claims (id) on delete cascade,

  expense_date        date not null,
  -- Fixed-list category enum. Add a new value with a migration when
  -- the operator needs one — keeps reporting clean. Mileage is
  -- treated as just another category for now (receipt = either the
  -- petrol receipt or a screenshot of the journey from Google Maps).
  category            text not null
                      check (category in ('travel', 'meals', 'supplies', 'mileage', 'training', 'other')),

  vendor              text check (vendor is null or length(vendor) <= 200),
  description         text check (description is null or length(description) <= 500),

  -- Gross amount including VAT. vat_amount is the portion of `amount`
  -- that is VAT. The net amount is amount - vat_amount.
  amount              numeric(10, 2) not null check (amount > 0),
  vat_amount          numeric(10, 2) not null default 0
                      check (vat_amount >= 0 and vat_amount <= amount),

  -- Receipt storage. Path is into the fte-expense-receipts bucket
  -- declared below. size_bytes + mime_type let the UI render the
  -- appropriate viewer without a HEAD round-trip.
  receipt_path        text,
  receipt_size_bytes  int check (receipt_size_bytes is null or receipt_size_bytes > 0),
  receipt_mime_type   text check (receipt_mime_type is null or length(receipt_mime_type) <= 100),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index fte_expense_items_claim_idx
  on public.fte_expense_items (claim_id, expense_date);

comment on column public.fte_expense_items.vat_amount is
  'Portion of `amount` that is VAT. CHECK (vat_amount <= amount). Net amount = amount - vat_amount. Required for Irish business VAT reclaim.';

-- ====================================================================
-- Trigger to maintain cached totals on the claim header
-- ====================================================================
--
-- The header carries total_amount + total_vat_amount + item_count so
-- list views don't re-aggregate per-row. Trigger recomputes on every
-- item INSERT / UPDATE / DELETE. Idempotent: re-running on the same
-- claim is a no-op cost-wise (single aggregate scan over a handful of
-- rows).

create or replace function public.fte_expense_recompute_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id uuid;
begin
  v_claim_id := coalesce(new.claim_id, old.claim_id);
  update public.fte_expense_claims c
     set total_amount     = coalesce((select sum(amount)     from public.fte_expense_items where claim_id = v_claim_id), 0),
         total_vat_amount = coalesce((select sum(vat_amount) from public.fte_expense_items where claim_id = v_claim_id), 0),
         item_count       = (select count(*) from public.fte_expense_items where claim_id = v_claim_id),
         updated_at       = now()
   where c.id = v_claim_id;
  return null;
end;
$$;

create trigger fte_expense_items_recompute
  after insert or update or delete on public.fte_expense_items
  for each row execute function public.fte_expense_recompute_totals();

-- ====================================================================
-- updated_at trigger on the header (for direct claim edits — notes,
-- period changes, status flips). Items have their own updated_at
-- maintained by the recompute trigger above.
-- ====================================================================

create or replace function public.fte_expense_claims_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger fte_expense_claims_updated_at
  before update on public.fte_expense_claims
  for each row execute function public.fte_expense_claims_touch_updated_at();

-- ====================================================================
-- RLS
-- ====================================================================

alter table public.fte_expense_claims enable row level security;
alter table public.fte_expense_items  enable row level security;

-- Read access:
--   • master sees everything (private.auth_is_master())
--   • owner sees claims at locations they own
--   • the submitter sees their own claims regardless of location
create policy fte_expense_claims_read on public.fte_expense_claims
  for select to authenticated
  using (
    profile_id = auth.uid()
    or exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role = 'master'
    )
    or exists (
      select 1 from public.profile_locations pl
       where pl.profile_id = auth.uid()
         and pl.location_id = fte_expense_claims.location_id
         and pl.role = 'owner'
    )
  );

create policy fte_expense_items_read on public.fte_expense_items
  for select to authenticated
  using (
    exists (
      select 1 from public.fte_expense_claims c
       where c.id = fte_expense_items.claim_id
         and (
              c.profile_id = auth.uid()
              or exists (
                select 1 from public.profiles p
                 where p.id = auth.uid() and p.role = 'master'
              )
              or exists (
                select 1 from public.profile_locations pl
                 where pl.profile_id = auth.uid()
                   and pl.location_id = c.location_id
                   and pl.role = 'owner'
              )
            )
    )
  );

-- Write access: service-role only. All inserts/updates/deletes go
-- through API routes that re-check authorisation in app code (so
-- e.g. "only the submitter can revoke" stays expressible). Absent
-- INSERT/UPDATE/DELETE policies → no authenticated writes.

-- ====================================================================
-- Storage bucket
-- ====================================================================
--
-- Private bucket; receipts only accessed via signed URLs minted by
-- /api/expenses/[id]/items/[itemId]/receipt. Bucket-level RLS denies
-- direct downloads even with a logged-in JWT.

insert into storage.buckets (id, name, public)
  values ('fte-expense-receipts', 'fte-expense-receipts', false)
  on conflict (id) do nothing;

-- Belt-and-braces deny-all on the bucket — same pattern as
-- contractor-invoices (mig 101). Server-side code uses the
-- service-role client to upload/download.
create policy fte_expense_receipts_deny_all on storage.objects
  for all to authenticated
  using (bucket_id <> 'fte-expense-receipts')
  with check (bucket_id <> 'fte-expense-receipts');
