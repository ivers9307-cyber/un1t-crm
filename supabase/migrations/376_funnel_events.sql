-- FUNNEL-EVENTS — append-only capture of /start booking-funnel step events, so
-- the drop-off point is queryable from the CRM (the Ads dashboard reads this),
-- location- and ad-segmented. Written by the public /api/public/funnel-event
-- endpoint; read via service-role routes (RLS is service-only, matching the
-- sibling snapshot/queue tables).
create table if not exists funnel_events (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  session_id text not null,
  funnel text not null default 'start',
  step text not null,
  ad_provider text,
  ad_external_id text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists funnel_events_loc_created on funnel_events (location_id, created_at);
create index if not exists funnel_events_loc_funnel_step on funnel_events (location_id, funnel, step);
create index if not exists funnel_events_ad on funnel_events (location_id, ad_external_id) where ad_external_id is not null;
create index if not exists funnel_events_session on funnel_events (session_id);
alter table funnel_events enable row level security;
create policy funnel_events_service_read on funnel_events for select to authenticated using (false);
