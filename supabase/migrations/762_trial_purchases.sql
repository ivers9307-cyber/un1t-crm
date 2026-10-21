-- PAIDTRIAL.1 — paid trial purchases (the Stillorgan €39 two-week trial sold
-- from the /trial Meta-ads page). One row per purchase: the money's lifecycle
-- (same columns as the paid class-funnel intro, mig 438) and then the grant
-- of the Glofox plan onto the buyer's account, run by a QStash worker with
-- the process-trial-purchases cron as the sweeper (the class-bookings shape).
--
-- status: awaiting_payment | queued | processing | granted | needs_review | failed | payment_failed
-- grant: write-ahead marker, { stage: 'purchasing', at } before the Glofox
--   purchase and the outcome after it, so a purchase Glofox never answered is
--   never bought twice (TRIALGRANT.1).

create table if not exists public.trial_purchases (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  landing_path text,
  customer_name text,
  first_name text,
  last_name text,
  customer_email text not null,
  customer_phone text,
  product_name text not null,
  membership_id text not null,
  plan_code text not null,
  duration_days integer not null default 14,
  amount_cents integer not null,
  currency text not null default 'EUR',
  status text not null default 'awaiting_payment',
  payment_status text,
  payment_provider text,
  payment_provider_ref text,
  payment_checkout_token text,
  payment_checkout_url text,
  connected_account_id text,
  paid_at timestamptz,
  glofox_member_id text,
  grant jsonb,
  granted_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  lead_event_id text,
  attribution jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_trial_purchases_queue on public.trial_purchases (created_at)
  where status in ('queued', 'processing');
create index if not exists idx_trial_purchases_provider_ref on public.trial_purchases (payment_provider_ref)
  where payment_provider_ref is not null;
create index if not exists idx_trial_purchases_contact on public.trial_purchases (contact_id);
create index if not exists idx_trial_purchases_location on public.trial_purchases (location_id);

create or replace trigger trg_trial_purchases_updated_at before update on public.trial_purchases
  for each row execute function update_updated_at();

-- Service-role only: the public routes, the webhook, the worker and the cron
-- all run on the service role. No client session reads or writes it
-- (TABLEDEFAULTACL.1 makes this the default; stated so a later reset cannot
-- reopen it).
alter table public.trial_purchases enable row level security;
revoke all on public.trial_purchases from anon, authenticated, public;

comment on table public.trial_purchases is 'PAIDTRIAL.1: paid trial purchases from the /trial page. Payment lifecycle then the Glofox plan grant (worker + process-trial-purchases cron). Service-role only.';
comment on column public.trial_purchases.grant is 'Write-ahead marker for the Glofox purchase: { stage: purchasing, at } before the call, the outcome after. A marker with no outcome is never bought again.';

-- Heartbeat for the sweeper (vercel.json: every 2 minutes). Grace sized so one
-- missed tick never pages (CLASSSYNCHB.1).
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
values ('process-trial-purchases', 120, 360, now())
on conflict (name) do nothing;
