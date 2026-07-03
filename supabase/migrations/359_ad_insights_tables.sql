create table if not exists ad_entities (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  ad_account_id uuid not null references ad_accounts(id) on delete cascade,
  provider text not null,
  level text not null check (level in ('campaign','adset','ad')),
  external_id text not null,
  name text,
  status text,
  campaign_external_id text,
  adset_external_id text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ad_entities_unique on ad_entities (ad_account_id, level, external_id);
create index if not exists ad_entities_location on ad_entities (location_id);

create table if not exists ad_insights_daily (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  ad_account_id uuid not null references ad_accounts(id) on delete cascade,
  provider text not null,
  level text not null,
  entity_external_id text not null,
  date date not null,
  spend numeric(12,2) default 0,
  impressions bigint default 0,
  reach bigint default 0,
  frequency numeric default 0,
  clicks bigint default 0,
  link_clicks bigint default 0,
  landing_page_views bigint default 0,
  ctr numeric default 0,
  cpc numeric default 0,
  cpm numeric default 0,
  results bigint default 0,
  result_type text,
  actions jsonb,
  synced_at timestamptz not null default now()
);
create unique index if not exists ad_insights_daily_unique on ad_insights_daily (ad_account_id, level, entity_external_id, date);
create index if not exists ad_insights_daily_loc_date on ad_insights_daily (location_id, date);
create index if not exists ad_insights_daily_acct_level_date on ad_insights_daily (ad_account_id, level, date);

create table if not exists ad_insights_breakdown_daily (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  ad_account_id uuid not null references ad_accounts(id) on delete cascade,
  provider text not null,
  level text not null,
  entity_external_id text not null,
  date date not null,
  dimension text not null,
  segment text not null,
  spend numeric(12,2) default 0,
  impressions bigint default 0,
  clicks bigint default 0,
  link_clicks bigint default 0,
  results bigint default 0,
  actions jsonb,
  synced_at timestamptz not null default now()
);
create unique index if not exists ad_bd_unique on ad_insights_breakdown_daily (ad_account_id, level, entity_external_id, date, dimension, segment);
create index if not exists ad_bd_loc_date_dim on ad_insights_breakdown_daily (location_id, date, dimension);

alter table ad_entities enable row level security;
alter table ad_insights_daily enable row level security;
alter table ad_insights_breakdown_daily enable row level security;
create policy ad_entities_svc on ad_entities for select to authenticated using (false);
create policy ad_insights_svc on ad_insights_daily for select to authenticated using (false);
create policy ad_bd_svc on ad_insights_breakdown_daily for select to authenticated using (false);
