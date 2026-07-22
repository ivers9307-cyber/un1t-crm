-- Paid intro offer (Phase 1): payment lifecycle columns on class_booking_requests.
-- A paid class-funnel booking is held `status='awaiting_payment'` with these
-- fields until the signed provider webhook (or the poll route's re-check)
-- releases it to `status='queued'`. NULL payment_status ⇒ free booking.
alter table public.class_booking_requests
  add column if not exists payment_status text,
  add column if not exists payment_provider text,
  add column if not exists payment_provider_ref text,
  add column if not exists payment_checkout_token text,
  add column if not exists payment_checkout_url text,
  add column if not exists amount_cents integer,
  add column if not exists currency text;

comment on column public.class_booking_requests.payment_status is
  'NULL = free booking (no payment). Else pending|paid|failed|expired. Set only via the signed provider webhook / provider re-check.';
comment on column public.class_booking_requests.payment_provider_ref is
  'Provider order/session id used for webhook lookup and status re-check.';

create index if not exists class_booking_requests_payment_provider_ref_idx
  on public.class_booking_requests (payment_provider_ref)
  where payment_provider_ref is not null;
