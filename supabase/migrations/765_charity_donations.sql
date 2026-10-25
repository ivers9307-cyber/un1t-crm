-- CHARITY.1 — donations on the public event page.
--
-- Three parts:
--   1. public.donations: one row per card donation taken on /event/[slug]
--      (the money's lifecycle, the shape of trial_purchases / mig 762).
--   2. race_events.charity_enabled + race_events.charity: the per-event charity
--      settings. Both are withheld from client grants; the public events read
--      goes through the service role and returns only what the page needs.
--   3. webhook_events_provider_check gains 'revolut_donation' for the new
--      POST /api/webhooks/revolut/donations dedupe key.
--
-- status: awaiting_payment | paid | failed | expired | refunded
--   awaiting_payment -> paid | failed | expired, and paid -> refunded. A Stripe
--   refund arrives on charge.refunded; a Revolut refund is recorded by a person
--   from the donations list (refunded_at + refunded_by) and moves no money.
-- match_multiplier: snapshot of the event's multiplier taken when the donation
--   is marked paid, so a later change to the event never rewrites history.
-- receipt_email_status: 'sent' | 'suppressed' | 'failed'; null until a receipt
--   has been attempted (receipt_email_sent_at is the stamp for 'sent').
--
-- Applied via Supabase MCP against iyvtbjjxdggiadzwwvdj BEFORE the code deploys.

create table if not exists public.donations (
  id uuid primary key default gen_random_uuid(),
  -- An event with money on it is soft-deleted (active=false), never dropped.
  race_event_id uuid not null references public.race_events(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  donor_name text not null,
  donor_email text not null,
  message text,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'EUR',
  match_multiplier numeric(3,1) not null default 1,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'paid', 'failed', 'expired', 'refunded')),
  payment_provider text,
  payment_provider_ref text,
  payment_checkout_token text,
  payment_checkout_url text,
  connected_account_id text,
  paid_at timestamptz,
  refunded_at timestamptz,
  refunded_by uuid references public.profiles(id) on delete set null,
  receipt_email_sent_at timestamptz,
  receipt_email_status text,
  marketing_opt_in boolean not null default false,
  attribution jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_donations_event_status on public.donations (race_event_id, status);
create index if not exists idx_donations_provider_ref on public.donations (payment_provider_ref)
  where payment_provider_ref is not null;
create index if not exists idx_donations_contact on public.donations (contact_id);

create or replace trigger trg_donations_updated_at before update on public.donations
  for each row execute function update_updated_at();

-- Service-role only: the public routes, the webhooks and the operator routes
-- all run on the service role. No client session reads or writes it, and no
-- policy is created (TABLEDEFAULTACL.1 makes this the default; stated so a
-- later reset cannot reopen it).
alter table public.donations enable row level security;
revoke all on public.donations from anon, authenticated, public;

comment on table public.donations is 'CHARITY.1: donations taken on the public event page. Service-role only.';
comment on column public.donations.match_multiplier is 'Snapshot of the event match multiplier at the moment the donation was marked paid.';
comment on column public.donations.refunded_by is 'Who recorded a Revolut refund from the donations list; null for a Stripe-reported refund.';
comment on column public.donations.receipt_email_status is 'sent | suppressed | failed; null until a receipt has been attempted.';

-- The per-event charity settings. No GRANT: these columns are not handed to
-- anon or authenticated, and the migration grants nothing new to clients.
-- column-grant: withheld race_events.charity_enabled
-- column-grant: withheld race_events.charity
alter table public.race_events
  add column if not exists charity_enabled boolean not null default false,
  add column if not exists charity jsonb;

comment on column public.race_events.charity_enabled is 'CHARITY.1: the donations section shows on the public event page.';
comment on column public.race_events.charity is 'CHARITY.1: charity settings group (validated by Zod on write); null means defaults.';

-- webhook_events.provider: add 'revolut_donation' to mig 505's eleven values.
ALTER TABLE public.webhook_events DROP CONSTRAINT IF EXISTS webhook_events_provider_check;
ALTER TABLE public.webhook_events ADD CONSTRAINT webhook_events_provider_check
  CHECK (provider IN (
    'postmark',
    'revolut',
    'revolut_race',
    'revolut_class_booking',
    'revolut_offer',
    'whatsapp',
    'instagram',
    'twilio',
    'xero',
    'unifi_access',
    'unifi_protect',
    'revolut_donation'
  ));
