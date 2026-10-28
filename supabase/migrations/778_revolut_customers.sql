-- 778 REVPAY.13 — reuse Revolut customers instead of creating one per order.
--
-- Since REVPAY.7 every order is sent `customer: { email, full_name }` with no
-- `id`. Revolut's spec (merchant-2026-03-12, Customer-v2) says that ALWAYS
-- creates a new customer record, "irrespective of another, existing customer
-- object having the same details", so the merchant dashboard filled with one
-- customer per order. The API cannot look a customer up by email
-- (GET /api/customers filters only by `from`/`to` dates), so we remember the
-- one we created: one row per (merchant account, normalised email).
--
-- `merchant` keys the row to a Revolut merchant ACCOUNT, so a second account
-- (or sandbox vs live) never hands out an id the other account does not have.
-- It is `<API base host>#<16 hex of sha256 over the API key>` (computed in
-- src/lib/revolut.js revolutMerchantKey): the host splits sandbox from live,
-- the key fingerprint splits accounts on the same host. A rotated key starts a
-- fresh set of rows (one extra customer per person, once); never a wrong one.
--
-- Written and read only by src/lib/revolut-customers.js on the service role.
-- Service-role only: no client privilege and no policy (RLS on).

create table if not exists public.revolut_customers (
  id uuid primary key default gen_random_uuid(),
  merchant text not null check (merchant <> ''),
  email_norm text not null check (email_norm <> '' and email_norm = lower(btrim(email_norm))),
  revolut_customer_id text not null check (revolut_customer_id <> ''),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  constraint revolut_customers_merchant_email_unique unique (merchant, email_norm)
);

alter table public.revolut_customers enable row level security;
revoke all on public.revolut_customers from anon, authenticated;

comment on table public.revolut_customers is 'REVPAY.13: the Revolut Merchant customer id we created for an email, per merchant account, so each order links to it (customer.id) instead of minting a duplicate. Service role only; src/lib/revolut-customers.js.';
comment on column public.revolut_customers.merchant is 'REVPAY.13: <Revolut API base host>#<16 hex of sha256 over the API key>. Splits sandbox/live and merchant accounts.';
comment on column public.revolut_customers.email_norm is 'REVPAY.13: lower(trim(email)).';
