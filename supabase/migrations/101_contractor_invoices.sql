-- Contractor invoice submission + approval workflow.
--
-- Contractors upload a PDF for a calendar-month period; an
-- owner/master at the contractor's location reviews the submission
-- against the actual scheduled hours pulled from shift_assignments
-- and either approves (forwards to Xero as a draft bill via the
-- existing email-to-bills pipe) or declines with a reason.
--
-- Period model: always 1st-of-month → last-day-of-month, enforced
-- by a trigger so manual SQL inserts can't drift.
--
-- Status flow: submitted → approved | declined. Resubmission after
-- decline = new row (partial unique index allows it).
--
-- Applied via Supabase MCP on 2026-05-05.

create table if not exists public.contractor_invoices (
  id uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.profiles(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  invoice_amount numeric(10, 2) not null check (invoice_amount > 0),
  invoice_number text,
  pdf_path text not null,
  pdf_size_bytes int,
  notes text,
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'declined')),
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  decline_reason text,
  approved_at timestamptz,
  xero_email_message_id text,
  xero_synced_at timestamptz,
  scheduled_hours_at_review numeric(8, 2),
  estimated_cost_at_review numeric(10, 2),
  hourly_rate_at_review numeric(10, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.tg_contractor_invoices_validate_period()
returns trigger language plpgsql as $$
begin
  if new.period_start <> date_trunc('month', new.period_start) then
    raise exception 'period_start must be the first day of a calendar month';
  end if;
  if new.period_end <> (date_trunc('month', new.period_start) + interval '1 month' - interval '1 day')::date then
    raise exception 'period_end must be the last day of period_start''s calendar month';
  end if;
  return new;
end $$;

drop trigger if exists contractor_invoices_validate_period on public.contractor_invoices;
create trigger contractor_invoices_validate_period
  before insert or update on public.contractor_invoices
  for each row execute function public.tg_contractor_invoices_validate_period();

drop trigger if exists contractor_invoices_touch on public.contractor_invoices;
create trigger contractor_invoices_touch
  before update on public.contractor_invoices
  for each row execute function public.update_updated_at();

create unique index if not exists contractor_invoices_one_active_per_period
  on public.contractor_invoices (contractor_id, period_start)
  where status <> 'declined';

create index if not exists contractor_invoices_review_queue_idx
  on public.contractor_invoices (location_id, status, submitted_at desc)
  where status = 'submitted';

create index if not exists contractor_invoices_by_contractor_idx
  on public.contractor_invoices (contractor_id, period_start desc);

insert into storage.buckets (id, name, public)
values ('contractor-invoices', 'contractor-invoices', false)
on conflict (id) do nothing;

do $$
begin
  drop policy if exists "deny all on contractor-invoices" on storage.objects;
exception when others then null;
end $$;

create policy "deny all on contractor-invoices"
  on storage.objects
  for all
  to authenticated, anon
  using (bucket_id <> 'contractor-invoices')
  with check (bucket_id <> 'contractor-invoices');

comment on table public.contractor_invoices is
  'Contractor invoice submissions per calendar month + owner/master review state. PDF lives in storage.objects bucket=contractor-invoices.';
