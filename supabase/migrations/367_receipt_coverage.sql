-- 367_receipt_coverage.sql
-- RECEIPT-COVERAGE.P0 — coverage ledger for unreconciled Xero bank lines.
-- Spec: un1t-finance-agent/docs/superpowers/specs/2026-07-04-receipt-coverage-design.md
-- Both tables are service-role-only: all access goes through /api routes
-- (guarded in code per CLAUDE.md); no authenticated policies on purpose.

create table public.recon_bank_lines (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  xero_bank_account_id text not null,
  bank_account_name text,
  -- Stable identity for a statement line across pulls:
  -- sha256(accountId|date|amount|normalized description|ordinal).
  xero_line_key text not null,
  line_date date not null,
  amount numeric not null,          -- signed as reported (money out = negative)
  description text,
  reference text,
  -- Full lifecycle enum now (Phase 1 uses submitted/not_found/needs_attention)
  -- so we don't need another migration to extend the check.
  status text not null default 'uncovered'
    check (status in ('uncovered','submitted','covered','not_found','needs_attention','ignored')),
  invoices_queue_id uuid references public.invoices_queue(id),
  ignore_reason text,
  ignored_by uuid references public.profiles(id),
  ignored_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  covered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index recon_bank_lines_key_idx
  on public.recon_bank_lines (location_id, xero_line_key);
create index recon_bank_lines_board_idx
  on public.recon_bank_lines (location_id, status, line_date desc);

alter table public.recon_bank_lines enable row level security;
create policy "service-role-all" on public.recon_bank_lines
  for all to service_role using (true) with check (true);

create table public.recon_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('cron','manual')),
  location_id uuid references public.locations(id),  -- null for a combined cron run
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','ok','error')),
  stats jsonb,
  error text
);
create index recon_runs_recent_idx on public.recon_runs (started_at desc);

alter table public.recon_runs enable row level security;
create policy "service-role-all" on public.recon_runs
  for all to service_role using (true) with check (true);

insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) values
  ('receipt-coverage-weekly', 604800, 86400,
   'Friday 08:00 Dublin — pull unreconciled Xero bank lines + coverage report email')
on conflict (name) do nothing;
