-- SUPPLIER-MEMORY.1 — per-supplier coding memory for the invoice ingest.
--
-- Today the invoice ingest reads every supplier invoice from a clean
-- slate: Claude Vision extracts the fields, the operator picks the
-- Xero supplier + account by hand, and nothing is carried forward —
-- the next invoice from the same supplier starts over.
--
-- This table makes the ingest LEARN. When an invoice is data-approved
-- against an existing Xero contact, we remember which Xero account +
-- category that supplier's invoice was coded to. The next invoice
-- from the same supplier is then pre-filled (supplier matched,
-- account + category set) and the operator just confirms.
--
-- Keyed (location_id, xero_contact_id) — one remembered coding per
-- supplier per location, the same scoping rule as xero_contacts /
-- xero_accounts: a Xero ContactID is only meaningful inside its
-- tenant, and tenants are per-location.

set check_function_bodies = off;

create table public.xero_supplier_defaults (
  id                       uuid primary key default gen_random_uuid(),
  location_id              uuid not null references public.locations (id) on delete cascade,

  -- The Xero ContactID this remembered coding belongs to. Matches
  -- xero_contacts.xero_contact_id.
  xero_contact_id          text not null,

  -- Display only — the supplier name as last seen. Handy for an
  -- admin / debug view; the picker resolves the live name from
  -- xero_contacts.
  supplier_name            text,

  -- The remembered coding. account_code is the operator-visible code
  -- ("400"); xero_account_id is the GUID the /Invoices push actually
  -- needs. category is one of the INVOICE_CATEGORIES enum, used as
  -- the human-facing hint.
  default_account_code     text,
  default_xero_account_id  text,
  default_category         text,

  -- How many invoices from this supplier have been coded this way,
  -- and when the most recent one was approved. Lets a future UI show
  -- confidence / recency; not load-bearing.
  use_count                int not null default 1,
  last_used_at             timestamptz not null default now(),

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint xero_supplier_defaults_one_per_location
    unique (location_id, xero_contact_id)
);

create index xero_supplier_defaults_lookup_idx
  on public.xero_supplier_defaults (location_id, xero_contact_id);

comment on table public.xero_supplier_defaults is
  'SUPPLIER-MEMORY.1 — remembered Xero account + category per supplier per location. Written when an invoice is data-approved; read to pre-fill the next invoice from the same supplier.';

-- updated_at trigger — same pattern as xero_contacts (mig 186).
create or replace function public.xero_supplier_defaults_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger xero_supplier_defaults_updated_at
  before update on public.xero_supplier_defaults
  for each row execute function public.xero_supplier_defaults_touch_updated_at();

-- RLS — mirrors xero_contacts (mig 186): location members can read,
-- writes are service-role only (the ingest routes use the
-- service-role client).
alter table public.xero_supplier_defaults enable row level security;

create policy xero_supplier_defaults_member_select on public.xero_supplier_defaults
  for select to authenticated
  using (private.auth_is_in_location(location_id));

-- ====================================================================
-- Backfill — seed memory from invoices already approved.
-- ====================================================================
-- So the feature is useful on day one rather than needing to be
-- re-trained from zero. For every supplier with at least one
-- data-approved / forwarded invoice that picked an existing Xero
-- contact + account, take the most recent coding.

with ranked as (
  select
    q.location_id,
    q.extracted_fields->'xero_contact_ref'->>'xero_contact_id' as xero_contact_id,
    q.extracted_fields->'xero_contact_ref'->>'name'            as supplier_name,
    nullif(q.extracted_fields->>'account_code', '')            as account_code,
    nullif(q.extracted_fields->>'xero_account_id', '')         as xero_account_id,
    nullif(q.extracted_fields->>'category', '')                as category,
    q.data_reviewed_at,
    row_number() over (
      partition by q.location_id,
                   q.extracted_fields->'xero_contact_ref'->>'xero_contact_id'
      order by q.data_reviewed_at desc nulls last
    ) as rn,
    count(*) over (
      partition by q.location_id,
                   q.extracted_fields->'xero_contact_ref'->>'xero_contact_id'
    ) as cnt
  from public.invoices_queue q
  where q.status in ('data_approved', 'forwarded')
    and q.extracted_fields->'xero_contact_ref'->>'kind' = 'existing'
    and coalesce(q.extracted_fields->'xero_contact_ref'->>'xero_contact_id', '') <> ''
    and coalesce(q.extracted_fields->>'xero_account_id', '') <> ''
)
insert into public.xero_supplier_defaults
  (location_id, xero_contact_id, supplier_name,
   default_account_code, default_xero_account_id, default_category,
   use_count, last_used_at)
select location_id, xero_contact_id, supplier_name,
       account_code, xero_account_id, category,
       cnt, coalesce(data_reviewed_at, now())
from ranked
where rn = 1
on conflict (location_id, xero_contact_id) do nothing;
