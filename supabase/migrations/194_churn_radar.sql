-- 194_churn_radar.sql
--
-- CHURN-RADAR.1 — at-risk member radar.
--
-- Logs every action a coach takes from the churn radar (contacted a
-- member, assigned a follow-up task, sent a win-back message, snoozed
-- someone) and every quarantine triage decision on the zero-activity
-- "ghost member" records.
--
-- The risk score itself is computed on the fly from each contact's
-- engagement columns (src/lib/churn-radar.js) — cheap for the active
-- member base, so there is no score-cache table. This table is purely
-- the action / decision audit trail: it's what lets the radar show
-- "last contacted 3d ago" and hide recently-snoozed members.

begin;

create table if not exists public.churn_radar_actions (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.contacts(id) on delete cascade,
  location_id   uuid not null references public.locations(id) on delete cascade,
  action        text not null check (action in (
                  'contacted', 'task_assigned', 'winback_sent',
                  'snoozed', 'quarantine_stale', 'quarantine_keep')),
  note          text,
  snooze_until  timestamptz,           -- set only for action = 'snoozed'
  actor_id      uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_churn_radar_actions_contact
  on public.churn_radar_actions (contact_id, created_at desc);
create index if not exists idx_churn_radar_actions_location
  on public.churn_radar_actions (location_id, created_at desc);

alter table public.churn_radar_actions enable row level security;

-- Staff at the action's location can read the log — it drives the
-- "last contacted" / snooze state shown in the radar UI.
create policy "Staff can view churn radar actions"
  on public.churn_radar_actions for select to public
  using (private.auth_is_in_location(location_id));

-- Writes are service-role only. The /api/churn-radar/* routes do
-- their own churn_radar-permission authz before inserting.

comment on table public.churn_radar_actions is
  'Audit trail of churn-radar coach actions + quarantine triage decisions. CHURN-RADAR.1.';

commit;
