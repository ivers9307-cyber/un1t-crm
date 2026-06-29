-- Async queue for public /start class-booking requests.
--
-- NOTE: this table was first applied to the un1t-crm project via the Supabase
-- MCP (apply_migration 'class_booking_requests_queue', 2026-06-29) — which
-- records to the remote project's migration history but does not write a repo
-- file. This migration records the same DDL in the tree for reproducibility;
-- it is idempotent (IF NOT EXISTS / OR REPLACE / ON CONFLICT) so it is a no-op
-- everywhere it has already been applied.
--
-- Drained by the process-class-bookings cron: resolves the Glofox account,
-- books the class (or routes to staff review on prior-attendance / failure),
-- and sends the booking_class_confirmed WhatsApp. Service-role only — staff
-- review happens via agent_membership_requests + /approvals, not this table.
-- The review insert uses agent_membership_requests.kind = 'class_booking',
-- already permitted by that table's kind CHECK (migrations 258 / 264).
create table if not exists public.class_booking_requests (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  glofox_event_id text not null,
  class_name text,
  starts_at timestamptz,
  customer_name text,
  customer_email text,
  customer_phone text,
  status text not null default 'queued',          -- queued|processing|booked|needs_review|failed
  attempts int not null default 0,
  last_error text,
  glofox_booking_id text,
  approval_request_id uuid references public.agent_membership_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cbr_status_queued on public.class_booking_requests (created_at)
  where status in ('queued','processing');
create index if not exists idx_cbr_location on public.class_booking_requests (location_id);
create index if not exists idx_cbr_contact on public.class_booking_requests (contact_id);

-- One active/booked request per (contact, class) — dedupes double-submits +
-- guarantees it under a concurrent race (the enqueue route treats the 23505
-- violation as a successful dedupe). Partial, so re-attempts are allowed after
-- a prior request goes to review/failed. (Applied to prod via the Supabase MCP
-- migration 'class_booking_requests_dedupe_index'.)
create unique index if not exists uq_cbr_active_contact_event
  on public.class_booking_requests (contact_id, glofox_event_id)
  where status in ('queued','processing','booked');

create or replace trigger trg_cbr_updated_at before update on public.class_booking_requests
  for each row execute function update_updated_at();

-- Service-role-only table (cron + public API routes use the RLS-bypassing
-- service role). RLS on with no policies = deny for authenticated/anon, which
-- is correct: nothing user-facing reads this table. Matches the convention of
-- api_keys / studio_devices / pin_login_attempts etc.
alter table public.class_booking_requests enable row level security;

comment on table public.class_booking_requests is 'Async queue for public /start class-booking requests (drained by process-class-bookings cron). Service-role only; staff review via agent_membership_requests + /approvals.';

-- Heartbeat row for the new cron (it stamps this on every successful run).
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
values ('process-class-bookings', 60, 120, now())
on conflict (name) do nothing;
