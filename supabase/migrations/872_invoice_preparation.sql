-- INVOICEPREP.3 — read and check supplier invoices when they arrive.
--
-- Additions:
--   1. invoices_queue gains review_reasons (why a row needs a person; empty
--      means ready), prepared_at (when the arrival preparation finished) and
--      duplicate_of_id (the earlier row this one repeats).
--   2. invoices_queue_status_check allows the new 'not_invoice' status.
--   3. xero_supplier_defaults remembers a default tax type per supplier.
--   4. upsert_supplier_default takes a seventh argument, p_tax_type. A null
--      p_tax_type leaves the stored value unchanged. The six-argument
--      version is dropped in the same migration.
--   5. claim_invoice_analysis_batch claims 'received' rows as well as
--      'quality_approved' ones.
--
-- Grant decision: invoices_queue already has a table-level grant to
-- authenticated under its read policy, so the new columns are readable by the
-- same people who can already read the row; xero_supplier_defaults likewise
-- keeps its existing policy. No narrower grant is made.
--
-- Both functions stay executable by service_role only.

set check_function_bodies = off;

alter table public.invoices_queue
  add column if not exists review_reasons text[] not null default '{}',
  add column if not exists prepared_at timestamptz,
  add column if not exists duplicate_of_id uuid references public.invoices_queue(id) on delete set null;

comment on column public.invoices_queue.review_reasons is
  'INVOICEPREP.3: reasons this row needs a person; empty means ready.';
comment on column public.invoices_queue.prepared_at is
  'INVOICEPREP.3: when the arrival preparation (read and check) finished for this row.';
comment on column public.invoices_queue.duplicate_of_id is
  'INVOICEPREP.3: the earlier queue row this one repeats, if any.';

alter table public.invoices_queue drop constraint if exists invoices_queue_status_check;
alter table public.invoices_queue
  add constraint invoices_queue_status_check
  check (status in ('received','quality_approved','extracted','data_approved','forwarded','rejected','not_invoice'));

alter table public.xero_supplier_defaults
  add column if not exists default_tax_type text;

comment on column public.xero_supplier_defaults.default_tax_type is
  'INVOICEPREP.3: the tax type last used for this supplier; null until one is recorded.';

-- Supplier default: same atomic upsert as before, plus the tax type.
drop function if exists public.upsert_supplier_default(uuid, text, text, text, text, text);

create or replace function public.upsert_supplier_default(
  p_location_id uuid, p_xero_contact_id text, p_supplier_name text,
  p_account_code text, p_xero_account_id text, p_category text,
  p_tax_type text default null
) returns void language sql set search_path = '' as $$
  insert into public.xero_supplier_defaults
    (location_id, xero_contact_id, supplier_name, default_account_code, default_xero_account_id, default_category, default_tax_type, use_count, last_used_at)
  values
    (p_location_id, p_xero_contact_id, p_supplier_name, p_account_code, p_xero_account_id, p_category, p_tax_type, 1, now())
  on conflict (location_id, xero_contact_id) do update set
    use_count               = public.xero_supplier_defaults.use_count + 1,
    last_used_at            = now(),
    supplier_name           = coalesce(excluded.supplier_name, public.xero_supplier_defaults.supplier_name),
    default_account_code    = coalesce(excluded.default_account_code, public.xero_supplier_defaults.default_account_code),
    default_xero_account_id = excluded.default_xero_account_id,
    default_category        = coalesce(excluded.default_category, public.xero_supplier_defaults.default_category),
    default_tax_type        = coalesce(excluded.default_tax_type, public.xero_supplier_defaults.default_tax_type);
$$;

revoke execute on function public.upsert_supplier_default(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.upsert_supplier_default(uuid, text, text, text, text, text, text) to service_role;

-- Claim: received rows are analysed on arrival too.
create or replace function public.claim_invoice_analysis_batch(p_limit int)
returns setof public.invoices_queue
language sql
set search_path = ''
as $$
  update public.invoices_queue q
  set analysis_claimed_at = now()
  where q.id in (
    select id from public.invoices_queue
    where status in ('received', 'quality_approved')
      and analysis_queued_at is not null
      and (analysis_claimed_at is null or analysis_claimed_at < now() - interval '10 minutes')
    order by analysis_queued_at
    limit least(greatest(p_limit, 1), 50)
    for update skip locked
  )
  returning q.*;
$$;

revoke execute on function public.claim_invoice_analysis_batch(int) from public, anon, authenticated;
grant execute on function public.claim_invoice_analysis_batch(int) to service_role;
