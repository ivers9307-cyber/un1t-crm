-- XERO-API.1 — chart-of-accounts + contacts cache (PR 1 of 3).
--
-- Why we're caching Xero refs locally
-- -----------------------------------
-- The /invoices accountant-review surface needs to let the
-- bookkeeper pick an exact Xero AccountCode and an exact Xero
-- Contact (supplier) before the row is sent. Hitting /Accounts and
-- /Contacts live on every keystroke is slow + burns the API quota
-- (60 calls / min, 5000 / day per tenant), so we mirror both lists
-- into Postgres and refresh on demand. This is the same shape Dext
-- uses against Xero — a one-button-manual-refresh cache rather
-- than constant live calls.
--
-- Two tables, one shape per:
--   xero_accounts  — every account in the location's chart of
--                    accounts. The picker filters Type='EXPENSE'
--                    + Status='ACTIVE'; we keep everything else
--                    cached too so the same table can support
--                    future Xero pushes that touch revenue or
--                    bank accounts.
--   xero_contacts  — every contact (supplier OR customer) the
--                    location has. The supplier picker filters
--                    is_supplier=true; we keep customers too in
--                    case future flows (e.g. customer invoice
--                    push) want to read them.
--
-- Both tables key on (location_id, xero_*_id) because the same
-- Xero AccountID / ContactID is meaningful only within a single
-- tenant — different locations connect to different tenants and
-- the IDs don't cross.
--
-- Stale-row handling: each sync stamps last_synced_at=now() on
-- every row it touches. The sync helper then DELETEs any rows in
-- the same location whose last_synced_at is older than the sync
-- start time — that's how we capture deletes / archives upstream
-- in Xero. Cleaner than a per-row "active" flag because Xero's
-- archived accounts still come back via /Accounts with Status =
-- ARCHIVED, but a fully-deleted contact never comes back at all.
--
-- The "last synced at" the bookkeeper sees on the Settings card
-- lives on xero_connections (accounts_last_synced_at +
-- contacts_last_synced_at) — one row per location so it's the
-- right place to hang the "snapshot freshness" timestamp the UI
-- reads.

set check_function_bodies = off;

-- ====================================================================
-- xero_accounts — chart-of-accounts cache
-- ====================================================================

create table public.xero_accounts (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null references public.locations (id) on delete cascade,

  -- Xero's AccountID is a GUID; we store it as text to avoid any
  -- format assumption.
  xero_account_id   text not null,

  -- Code + Name come straight off /Accounts. Code is the operator-
  -- visible identifier (e.g. "400"); Name is the human label
  -- ("Sales"). Picker shows both: "400 — Sales".
  code              text,
  name              text not null check (length(name) between 1 and 200),

  -- Type categorises the account (EXPENSE, REVENUE, BANK, etc).
  -- The expense-bill picker filters on EXPENSE; other types stay
  -- in the cache for future flows.
  account_type      text,

  -- Status — ACTIVE | ARCHIVED. We hide ARCHIVED in pickers but
  -- still cache them in case existing extracted_fields reference
  -- one (we want to render the label, not "Unknown account").
  status            text,

  -- Tax type Xero applies to lines on this account by default
  -- (e.g. INPUT2 for 23% VAT in Ireland). Useful as a hint when
  -- the bookkeeper sets line tax in the future.
  tax_type          text,

  -- Whether this account is allowed on expense claims. We don't
  -- filter on it today but cache it for parity with /Accounts.
  show_in_expense_claims boolean,

  -- Sync timestamps. last_synced_at gets bumped to the sync start
  -- time on every UPSERT — the helper then deletes anything not
  -- touched in this sync (= no longer returned by /Accounts).
  last_synced_at    timestamptz not null default now(),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Same Xero AccountID can't appear twice in a single location's
  -- cache. Across locations the same ID could in theory recur
  -- (Xero doesn't guarantee global uniqueness across tenants), so
  -- we scope uniqueness per location.
  constraint xero_accounts_one_per_location unique (location_id, xero_account_id)
);

-- Picker filter: location_id, status, account_type, ordered by code.
create index xero_accounts_picker_idx
  on public.xero_accounts (location_id, account_type, status, code);

-- Reverse lookup: when an extracted_fields row stores a xero_account_id,
-- the renderer joins back to find the label.
create index xero_accounts_lookup_idx
  on public.xero_accounts (location_id, xero_account_id);

comment on table public.xero_accounts is
  'XERO-API.1 — cached chart of accounts per location. Refreshed manually from /Accounts via Settings UI; one row per AccountID per location.';
comment on column public.xero_accounts.account_type is
  'Xero AccountType — EXPENSE | REVENUE | BANK | CURRENT | EQUITY | FIXED | LIABILITY | OTHERINCOME | etc. /invoices picker filters on EXPENSE.';
comment on column public.xero_accounts.status is
  'ACTIVE | ARCHIVED. Pickers hide ARCHIVED but the cache keeps them so historical references still render.';
comment on column public.xero_accounts.last_synced_at is
  'Bumped to the sync start time on every UPSERT. Rows older than that timestamp after sync are deleted (= no longer in Xero).';

-- ====================================================================
-- xero_contacts — supplier + customer cache
-- ====================================================================

create table public.xero_contacts (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null references public.locations (id) on delete cascade,

  xero_contact_id   text not null,

  -- Name is the picker's primary display + autocomplete field.
  name              text not null check (length(name) between 1 and 500),

  -- Email is shown alongside name in the picker for disambiguation
  -- when two contacts share a name (rare but happens with chain
  -- suppliers).
  email             text,

  -- Supplier / customer flags. Supplier picker filters
  -- is_supplier = true; the other flag stays cached for future
  -- flows.
  is_supplier       boolean default false,
  is_customer       boolean default false,

  -- Xero ContactStatus — ACTIVE | ARCHIVED.
  status            text,

  -- Optional fields useful for the picker preview.
  default_currency  text check (default_currency is null or length(default_currency) = 3),
  tax_number        text,

  -- See xero_accounts.last_synced_at note — same stale-row handling.
  last_synced_at    timestamptz not null default now(),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint xero_contacts_one_per_location unique (location_id, xero_contact_id)
);

-- Picker filter: location_id, status, is_supplier, ordered by name.
create index xero_contacts_supplier_picker_idx
  on public.xero_contacts (location_id, is_supplier, status, name)
  where is_supplier = true;

-- Generic fast lookup by name for autocomplete. lower(name) so
-- the search input matches case-insensitively against this index.
create index xero_contacts_name_lower_idx
  on public.xero_contacts (location_id, lower(name));

-- Reverse lookup when extracted_fields stores a xero_contact_id.
create index xero_contacts_lookup_idx
  on public.xero_contacts (location_id, xero_contact_id);

comment on table public.xero_contacts is
  'XERO-API.1 — cached Xero contacts per location. Refreshed manually from /Contacts via Settings UI. Drives the supplier picker on /invoices accountant review + the "create new contact" inline-create flow.';
comment on column public.xero_contacts.is_supplier is
  'Xero IsSupplier flag — true means the contact appears in Bills as a payable supplier. /invoices picker filters on this.';

-- ====================================================================
-- xero_connections — sync timestamps
-- ====================================================================
--
-- The Settings card shows "Accounts last synced 2 min ago" and
-- "Contacts last synced 4 hours ago" alongside the manual-refresh
-- buttons. We track those timestamps on the connection row so the
-- card can read them in one shot without scanning the cache table.

alter table public.xero_connections
  add column if not exists accounts_last_synced_at timestamptz,
  add column if not exists contacts_last_synced_at timestamptz,
  add column if not exists accounts_sync_error text,
  add column if not exists contacts_sync_error text;

comment on column public.xero_connections.accounts_last_synced_at is
  'XERO-API.1 — when the cached xero_accounts rows were last refreshed for this location. NULL means never synced.';
comment on column public.xero_connections.contacts_last_synced_at is
  'XERO-API.1 — when the cached xero_contacts rows were last refreshed for this location.';
comment on column public.xero_connections.accounts_sync_error is
  'XERO-API.1 — last error message from /Accounts sync (cleared on success). UI shows this if non-null after a sync attempt.';

-- ====================================================================
-- updated_at triggers — reuse the inbound-style helper pattern
-- ====================================================================

create or replace function public.xero_accounts_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger xero_accounts_updated_at
  before update on public.xero_accounts
  for each row execute function public.xero_accounts_touch_updated_at();

create or replace function public.xero_contacts_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger xero_contacts_updated_at
  before update on public.xero_contacts
  for each row execute function public.xero_contacts_touch_updated_at();

-- ====================================================================
-- RLS
-- ====================================================================
--
-- Cache rows mirror xero_connections sensitivity — only members of
-- the location should see them (a contact list IS commercially
-- sensitive). Reuse the `private.auth_is_in_location` helper that
-- xero_connections already uses (mig 029) for consistency.

alter table public.xero_accounts enable row level security;
alter table public.xero_contacts enable row level security;

create policy xero_accounts_member_select on public.xero_accounts
  for select to authenticated
  using (private.auth_is_in_location(location_id));

create policy xero_contacts_member_select on public.xero_contacts
  for select to authenticated
  using (private.auth_is_in_location(location_id));

-- Writes are service-role only (no INSERT/UPDATE/DELETE policy).
-- The sync helpers in src/lib/xero/accounts-sync.js +
-- contacts-sync.js use the service-role client.
