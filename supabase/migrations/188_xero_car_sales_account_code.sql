-- CAR-SALES-ACCOUNT.1 — per-location car-invoice sales account code.
--
-- The car-invoice issue route (POST /api/cars/[id]/issue-xero-invoice)
-- previously hardcoded its AccountCode as `process.env.XERO_SALES_ACCOUNT_CODE
-- || '200'`. In Champ Fitness Ltd's chart of accounts code 200 is
-- "Sales - gym" (with the wrong tax type for car sales) — the right
-- account for CCF Autos cars is 215 "Sales of motor vehicles".
--
-- Each location has its own Xero tenant + chart of accounts (mig 029
-- + mig 186), so this setting is naturally per-location. Stored on
-- the xero_connections row so it lives next to the connected
-- tenant_id + Xero credentials.
--
-- Null = fall back to env-var XERO_SALES_ACCOUNT_CODE for back-compat
-- (or '200' if that's not set either). The Settings UI in this PR
-- requires explicit selection from the cached chart of accounts —
-- the null state is just for connections that existed pre-migration
-- and haven't been re-saved.

set check_function_bodies = off;

alter table public.xero_connections
  add column if not exists car_sales_account_code text
    check (car_sales_account_code is null or length(car_sales_account_code) between 1 and 50);

comment on column public.xero_connections.car_sales_account_code is
  'CAR-SALES-ACCOUNT.1 — Xero account code (e.g. "215") used for the car-invoice issue route''s LineItem.AccountCode. Picked per-location via the Xero card in Settings → Integrations, sourced from xero_accounts cache (mig 186). NULL = falls back to env XERO_SALES_ACCOUNT_CODE then to ''200''.';
