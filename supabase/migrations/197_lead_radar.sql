-- 197_lead_radar.sql
--
-- LEAD-RADAR.1 — non-member triage radar.
--
-- Logs every action a coach takes from the Lead Radar (contacted a
-- prospect, snoozed one) and every cleanup triage decision on the
-- dormant lead/trial records (archive candidate / keep).
--
-- Like the Churn Radar, the funnel score + cleanup bucket are
-- computed on the fly from each contact's status / activity /
-- joined_at (src/lib/lead-radar.js), so there is no score-cache
-- table. This table is purely the action / decision audit trail:
-- it's what lets the radar show "last contacted 3d ago", hide
-- recently-snoozed prospects, and drop already-triaged records off
-- the cleanup list.

begin;

create table if not exists public.lead_radar_actions (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.contacts(id) on delete cascade,
  location_id   uuid not null references public.locations(id) on delete cascade,
  action        text not null check (action in (
                  'contacted', 'snoozed',
                  'cleanup_archive', 'cleanup_keep')),
  note          text,
  snooze_until  timestamptz,           -- set only for action = 'snoozed'
  actor_id      uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_lead_radar_actions_contact
  on public.lead_radar_actions (contact_id, created_at desc);
create index if not exists idx_lead_radar_actions_location
  on public.lead_radar_actions (location_id, created_at desc);

alter table public.lead_radar_actions enable row level security;

-- Staff at the action's location can read the log — it drives the
-- "last contacted" / snooze state shown in the radar UI.
create policy "Staff can view lead radar actions"
  on public.lead_radar_actions for select to public
  using (private.auth_is_in_location(location_id));

-- Writes are service-role only. The /api/lead-radar/* routes do
-- their own lead_radar-permission authz before inserting.

comment on table public.lead_radar_actions is
  'Audit trail of lead-radar coach actions + cleanup triage decisions. LEAD-RADAR.1.';

commit;
