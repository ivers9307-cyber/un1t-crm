-- 774 REVPAY.4 — Revolut disputes (chargebacks) become visible.
--
-- Revolut Merchant sends DISPUTE_ACTION_REQUIRED / DISPUTE_UNDER_REVIEW /
-- DISPUTE_WON / DISPUTE_LOST to POST /api/webhooks/revolut/disputes; the route
-- re-reads the dispute (GET /api/disputes/{id}) and upserts one row here, keyed
-- on Revolut's dispute id. source_type/source_id say which of our sales the
-- disputed order belonged to (null when the order is not ours).
--
-- Service-role only: no client privilege and no policy (RLS on). Written by the
-- webhook route; staff are told through the ops alert, not by reading this table.
--
-- webhook_events.provider gains 'revolut_dispute' (mig 765's twelve values + 1).

create table if not exists public.revolut_disputes (
  id uuid primary key default gen_random_uuid(),
  dispute_id text not null unique,
  order_id text,
  location_id uuid references public.locations(id) on delete set null,
  source_type text,
  source_id uuid,
  state text,
  reason text,
  amount_cents integer,
  currency text,
  due_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_revolut_disputes_order on public.revolut_disputes (order_id);
create index if not exists idx_revolut_disputes_location on public.revolut_disputes (location_id);

alter table public.revolut_disputes enable row level security;
revoke all on public.revolut_disputes from anon, authenticated;

comment on table public.revolut_disputes is 'REVPAY.4: one row per Revolut dispute (chargeback). Service role only; written by /api/webhooks/revolut/disputes. raw is the dispute object with the payer name stripped.';

alter table public.webhook_events drop constraint if exists webhook_events_provider_check;
alter table public.webhook_events add constraint webhook_events_provider_check
  check (provider in (
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
    'revolut_donation',
    'revolut_dispute'
  ));
