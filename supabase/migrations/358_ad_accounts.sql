create table if not exists ad_accounts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  provider text not null check (provider in ('meta','tiktok')),
  external_account_id text not null,
  access_token text,
  business_account_id text,
  currency text,
  account_timezone text,
  display_name text,
  is_active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ad_accounts_unique_ext
  on ad_accounts (location_id, provider, external_account_id);
create unique index if not exists ad_accounts_one_active
  on ad_accounts (location_id, provider) where is_active;
create index if not exists ad_accounts_location on ad_accounts (location_id);
alter table ad_accounts enable row level security;
create policy ad_accounts_service_read on ad_accounts for select to authenticated using (false);
