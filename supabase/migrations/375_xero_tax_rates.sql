-- XERO-BILL-VAT.2 — per-location Xero tax-rate cache.
--
-- Mirrors xero_accounts (mig 186): a manual-refresh cache of the
-- location's Xero /TaxRates, so the /invoices review UI can pick the
-- exact TaxType for a bill and the push can send the right VAT rate
-- instead of letting Xero apply the account default (the ROWfit
-- 0%-booked-at-23% bug, #816).
--
-- Rates are per Xero tenant, so per location. Stale-row handling is
-- identical to xero_accounts: stamp last_synced_at on every upsert,
-- delete rows older than the sync start.

set check_function_bodies = off;

create table public.xero_tax_rates (
  id                    uuid primary key default gen_random_uuid(),
  location_id           uuid not null references public.locations (id) on delete cascade,

  -- Xero TaxType code — the stable identifier (e.g. INPUT, TAX001,
  -- NONE). This is what LineItem.TaxType must carry.
  tax_type              text not null,

  -- Human label from Xero (e.g. "VAT on Purchases (23%)").
  name                  text not null check (length(name) between 1 and 200),

  -- Total effective rate as a percentage (e.g. 23, 13.5, 0).
  effective_rate        numeric,

  -- ACTIVE | DELETED | ARCHIVED.
  status                text,

  -- Applicability flags from Xero — bills use expense-applicable
  -- rates; revenue kept for parity / future customer-invoice use.
  can_apply_to_expenses boolean,
  can_apply_to_revenue  boolean,

  last_synced_at        timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint xero_tax_rates_one_per_location unique (location_id, tax_type)
);

create index xero_tax_rates_picker_idx
  on public.xero_tax_rates (location_id, status, can_apply_to_expenses);

comment on table public.xero_tax_rates is
  'XERO-BILL-VAT.2 — cached Xero tax rates per location. Refreshed manually (with accounts) via Settings + on connect. Drives the /invoices VAT-rate picker and the ACCPAY push TaxType.';

alter table public.xero_connections
  add column if not exists tax_rates_last_synced_at timestamptz,
  add column if not exists tax_rates_sync_error text;

comment on column public.xero_connections.tax_rates_last_synced_at is
  'XERO-BILL-VAT.2 — when xero_tax_rates was last refreshed for this location. NULL means never synced.';

-- updated_at trigger (same pattern as xero_accounts).
create or replace function public.xero_tax_rates_touch_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger xero_tax_rates_updated_at
  before update on public.xero_tax_rates
  for each row execute function public.xero_tax_rates_touch_updated_at();

-- RLS — location members read; writes are service-role only (no
-- write policy). Mirrors xero_accounts (mig 186).
alter table public.xero_tax_rates enable row level security;

create policy xero_tax_rates_member_select on public.xero_tax_rates
  for select to authenticated
  using (private.auth_is_in_location(location_id));
