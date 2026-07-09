-- HOST-PORTAL.4 — audit log for admin "view as host" sessions.
-- Mirrors impersonation_log (mig 035): one open row per admin at a time;
-- started on view-as, ended_at stamped on exit. Service-role only.
create table if not exists host_impersonation_log (
  id              uuid primary key default gen_random_uuid(),
  admin_user_id   uuid not null,
  host_id         uuid not null references event_hosts(id) on delete cascade,
  organization_id uuid,
  ip              text,
  user_agent      text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  auto_closed     boolean not null default false
);
alter table host_impersonation_log enable row level security;
create index if not exists idx_host_impersonation_open
  on host_impersonation_log (admin_user_id) where ended_at is null;

comment on table host_impersonation_log is
  'Audit of admin view-as-host sessions (HOST-PORTAL.4). Service-role only; access is authorized in app code (ADMIN_ROLES + org).';
