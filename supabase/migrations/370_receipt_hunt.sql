-- 370_receipt_hunt.sql
-- RCOV.P1 — hunt engine schema: operator inboxes, hunt audit, line
-- hunt-queue columns + atomic claim, invoices_queue email_hunt source
-- + content_hash dedupe, hunted-invoices bucket. Service-role-only
-- tables (routes are the security boundary, per CLAUDE.md).

-- 1. Operator inboxes (Gmail app passwords; same treatment as
--    xero_connections tokens: plain columns, service-role-only table).
create table public.recon_mailboxes (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  email text not null unique,
  imap_password text not null,
  active boolean not null default true,
  last_ok_at timestamptz,
  last_error text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.recon_mailboxes enable row level security;
create policy "service-role-all" on public.recon_mailboxes
  for all to service_role using (true) with check (true);

-- 2. Hunt audit — one row per line-per-attempt.
create table public.recon_hunts (
  id uuid primary key default gen_random_uuid(),
  bank_line_id uuid not null references public.recon_bank_lines(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('found','not_found','error')),
  queries jsonb,
  examined_message_ids text[] not null default '{}',
  found_message_id text,
  found_mailbox_id uuid references public.recon_mailboxes(id),
  submitted_queue_id uuid references public.invoices_queue(id),
  evidence jsonb,
  llm_spend_usd numeric not null default 0,
  error text
);
create index recon_hunts_line_idx on public.recon_hunts (bank_line_id, started_at desc);
alter table public.recon_hunts enable row level security;
create policy "service-role-all" on public.recon_hunts
  for all to service_role using (true) with check (true);

-- 3. Hunt-queue columns on the ledger (mirrors mig 220's analysis queue).
alter table public.recon_bank_lines
  add column hunt_queued_at timestamptz,
  add column hunt_claimed_at timestamptz,
  add column last_hunted_at timestamptz,
  add column hunt_attempts int not null default 0;
create index recon_bank_lines_hunt_pending_idx
  on public.recon_bank_lines (hunt_queued_at)
  where hunt_queued_at is not null;

-- 4. Atomic hunt claim (FOR UPDATE SKIP LOCKED; 10-min reclaim window).
create or replace function public.claim_recon_hunt_batch(p_limit int)
returns setof public.recon_bank_lines
language sql
set search_path = ''
as $$
  update public.recon_bank_lines l
  set hunt_claimed_at = now()
  where l.id in (
    select id from public.recon_bank_lines
    where status in ('uncovered','not_found')
      and hunt_queued_at is not null
      and (hunt_claimed_at is null or hunt_claimed_at < now() - interval '10 minutes')
    order by hunt_queued_at
    limit least(greatest(p_limit, 1), 10)
    for update skip locked
  )
  returning l.*;
$$;

-- 5. invoices_queue: email_hunt source + content-hash dedupe.
alter table public.invoices_queue
  add column if not exists source_hunt_id uuid references public.recon_hunts(id),
  add column if not exists content_hash text;
create index if not exists invoices_queue_source_hunt_idx
  on public.invoices_queue (source_hunt_id) where source_hunt_id is not null;
create index if not exists invoices_queue_content_hash_idx
  on public.invoices_queue (content_hash) where content_hash is not null;

alter table public.invoices_queue
  drop constraint if exists invoices_queue_source_type_check;
alter table public.invoices_queue
  add constraint invoices_queue_source_type_check
  check (source_type in (
    'supplier_email','contractor_invoice','fte_expense_item',
    'car_document','card_receipt','email_hunt'
  ));

alter table public.invoices_queue
  drop constraint if exists invoices_queue_source_xor;
alter table public.invoices_queue
  add constraint invoices_queue_source_xor check (
    (source_type = 'supplier_email'
      and source_contractor_invoice_id is null and source_fte_expense_item_id is null
      and source_car_document_id is null and source_card_receipt_id is null and source_hunt_id is null)
    or
    (source_type = 'contractor_invoice'
      and source_contractor_invoice_id is not null and source_fte_expense_item_id is null
      and source_car_document_id is null and source_card_receipt_id is null and source_hunt_id is null)
    or
    (source_type = 'fte_expense_item'
      and source_contractor_invoice_id is null and source_fte_expense_item_id is not null
      and source_car_document_id is null and source_card_receipt_id is null and source_hunt_id is null)
    or
    (source_type = 'car_document'
      and source_contractor_invoice_id is null and source_fte_expense_item_id is null
      and source_car_document_id is not null and source_card_receipt_id is null and source_hunt_id is null)
    or
    (source_type = 'card_receipt'
      and source_contractor_invoice_id is null and source_fte_expense_item_id is null
      and source_car_document_id is null and source_card_receipt_id is not null and source_hunt_id is null)
    or
    (source_type = 'email_hunt'
      and source_contractor_invoice_id is null and source_fte_expense_item_id is null
      and source_car_document_id is null and source_card_receipt_id is null and source_hunt_id is not null)
  );

-- 6. Private bucket for hunted documents (RESTRICTIVE deny — mig 325 lesson:
--    the older permissive per-bucket "deny" policies OR together and leak;
--    a restrictive policy ANDs with everything and actually denies).
insert into storage.buckets (id, name, public)
values ('hunted-invoices', 'hunted-invoices', false)
on conflict (id) do nothing;
do $$
begin
  drop policy if exists "hunted-invoices restrictive deny" on storage.objects;
exception when others then null;
end $$;
create policy "hunted-invoices restrictive deny"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'hunted-invoices')
  with check (bucket_id <> 'hunted-invoices');

-- 7. recon_runs gains the 'report' trigger (weekly finalize audit row).
alter table public.recon_runs drop constraint if exists recon_runs_trigger_check;
alter table public.recon_runs
  add constraint recon_runs_trigger_check check (trigger in ('cron','manual','report'));

-- 8. Drain-cron heartbeat.
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) values
  ('process-receipt-hunts', 600, 1200,
   'Every 5 min — drains the receipt-hunt queue (IMAP search + Claude scoring) and finalizes the weekly report')
on conflict (name) do nothing;
