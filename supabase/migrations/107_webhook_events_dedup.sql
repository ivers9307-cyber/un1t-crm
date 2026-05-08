-- Mig 107: webhook_events dedup table.
--
-- Backstop against duplicate webhook processing when the upstream
-- provider retries. Postmark, Revolut, and WhatsApp all retry on
-- non-2xx responses for hours-to-days; Twilio does the same. Our
-- existing per-feature idempotency (status comparisons in the cars
-- + race-payments paths, *_sent_at stamps in the confirmation paths)
-- is good but distributed. This is the single chokepoint.
--
-- Shape: one row per (provider, event_id). The webhook handler
-- attempts an INSERT before doing real work; if the unique violation
-- fires the second-arriving copy short-circuits.
--
-- event_id is the provider-specific identifier:
--   postmark      = `${RecordType}:${MessageID}` (one row per
--                   delivery + open + click + bounce per email)
--   revolut       = `${event}:${order_id}` (one row per order state
--                   transition; covers ORDER_AUTHORISED then
--                   ORDER_COMPLETED in the same flow)
--   revolut_race  = same shape as revolut
--   whatsapp      = `msg:${id}` for incoming, `status:${id}:${status}`
--                   for status updates
--   twilio        = `${MessageSid}:${MessageStatus}` (covered by
--                   existing recipient.status guard but we belt-and-
--                   braces it)
--   xero          = `${eventId}` (Xero supplies one per event)
--
-- Retention: rows older than 90 days are pruned by a simple TTL
-- cron in mig 108 (follow-up). 90 days is comfortably more than any
-- provider's retry window (the longest is Postmark at ~48h).

create extension if not exists pgcrypto;

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null
    check (provider in (
      'postmark', 'revolut', 'revolut_race',
      'whatsapp', 'twilio', 'xero'
    )),
  event_id text not null
    check (length(event_id) between 1 and 512),
  received_at timestamptz not null default now(),

  constraint webhook_events_provider_event_id_unique
    unique (provider, event_id)
);

-- Read pattern: never. Write pattern: insert-on-conflict from a
-- handful of routes. The unique index is the only one we need.
-- Add an explicit btree on received_at so the future TTL cleanup
-- cron's `delete from … where received_at < now() - interval '90 days'`
-- can use an index scan instead of a sequential scan once volume
-- grows.
create index webhook_events_received_at_idx
  on public.webhook_events (received_at);

-- RLS: hard-deny everyone. The table is only ever touched via the
-- service-role server-side. No UI surface, no per-user access.
alter table public.webhook_events enable row level security;

comment on table public.webhook_events is
  'Webhook dedup ledger (mig 107). Insert-on-conflict to short-circuit duplicate processing on provider retries. Service-role only.';

comment on column public.webhook_events.event_id is
  'Provider-specific composite key — see mig 107 header for the shape per provider.';
