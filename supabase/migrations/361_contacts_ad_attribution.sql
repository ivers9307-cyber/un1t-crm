alter table contacts
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists ad_provider text,
  add column if not exists ad_external_id text,
  add column if not exists attributed_at timestamptz;
create index if not exists contacts_ad_external on contacts (location_id, ad_external_id) where ad_external_id is not null;
