-- Stripe Connect direct charges need the connected account (acct_...) recorded on
-- the booking row for the poll re-check (getPayment) and any future refund. NULL
-- for Revolut. Additive/nullable.
alter table public.class_booking_requests
  add column if not exists connected_account_id text;
comment on column public.class_booking_requests.connected_account_id is
  'Stripe connected account (acct_...) for a stripe_connect direct charge; NULL for Revolut. Needed for the poll re-check / refunds.';
