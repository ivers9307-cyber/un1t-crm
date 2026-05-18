-- AUDIT-EXPAND.1 — unified audit log.
--
-- Replaces the single-purpose assignment_change_log (mig 080) with a
-- generic audit_events table that covers:
--   - 'auth'        — sign-in success/failure, sign-out, password
--                     change, impersonation start/stop.
--   - 'business'    — contract issued/signed/declined/revoked,
--                     policy published, member-data export.
--   - 'assignment'  — every event that previously lived in
--                     assignment_change_log (role grants, location
--                     assignment changes, profile activation flip).
--   - 'mutation'    — RESERVED for AUDIT-EXPAND.2 (DB-trigger
--                     based per-table audit). Schema accepts the
--                     enum value today so the v2 work doesn't need
--                     a fresh migration.
--
-- assignment_change_log stays in place for one release cycle. The
-- application's logAssignmentChange now writes to BOTH the legacy
-- table AND the new audit_events table, so a rollback doesn't lose
-- data either direction. Historic rows are backfilled at the tail
-- of this migration.

set check_function_bodies = off;

create table public.audit_events (
  id                   uuid primary key default gen_random_uuid(),
  occurred_at          timestamptz not null default now(),
  category             text not null
                       check (category in ('auth', 'business', 'mutation', 'assignment')),
  action               text not null check (length(action) between 1 and 80),

  -- Who did it. Nullable so we can capture system / cron / service-
  -- role mutations (the trigger-based v2 path) without faking an actor.
  actor_id             uuid references public.profiles (id) on delete set null,
  actor_label          text check (actor_label is null or length(actor_label) <= 200),

  -- Who it was done TO (when the event affects a specific user).
  -- E.g. contract issued to <recipient>, role granted to <target>.
  target_profile_id    uuid references public.profiles (id) on delete set null,
  target_label         text check (target_label is null or length(target_label) <= 200),

  -- The resource the event acted on, as a stable "type/id" string.
  -- E.g. 'contracts/<uuid>', 'policies/employee-handbook',
  -- 'profile_locations/<actor>:<target>:<loc>'. Lets the audit log
  -- link out to the source object when the row is expanded.
  target_resource      text check (target_resource is null or length(target_resource) <= 200),

  location_id          uuid references public.locations (id) on delete set null,

  -- Event-specific payload. Shape varies by action:
  --   auth.sign_in      → { ok, email, reason? }
  --   contract.issued   → { template_id, template_name }
  --   policy.published  → { version_number, change_summary, effective_date }
  --   assignment.update → { before, after }
  details              jsonb,

  ip_address           inet,
  user_agent           text check (user_agent is null or length(user_agent) <= 500)
);

-- Filter-shaped indexes. The audit-log UI filters on (actor, target,
-- location, category, action) + date range, sorted by occurred_at
-- desc. Each composite leads with the most-selective column for the
-- typical filter combos.
create index audit_events_occurred_idx       on public.audit_events (occurred_at desc);
create index audit_events_actor_idx          on public.audit_events (actor_id, occurred_at desc) where actor_id is not null;
create index audit_events_target_idx         on public.audit_events (target_profile_id, occurred_at desc) where target_profile_id is not null;
create index audit_events_location_idx       on public.audit_events (location_id, occurred_at desc) where location_id is not null;
create index audit_events_category_idx       on public.audit_events (category, occurred_at desc);
create index audit_events_action_idx         on public.audit_events (action, occurred_at desc);
create index audit_events_target_resource_idx on public.audit_events (target_resource) where target_resource is not null;

comment on table  public.audit_events is
  'AUDIT-EXPAND.1 — unified audit log. Replaces assignment_change_log; that table is still being written to during the transition cycle. RLS: master/owner SELECT only. INSERT via service role + the logAuditEvent helper.';
comment on column public.audit_events.category is
  'One of: auth, business, mutation, assignment. Drives the Category filter on /admin/audit-log.';
comment on column public.audit_events.action  is
  'Specific action key, e.g. ''auth.sign_in'', ''contract.issued'', ''policy.published''. Conventionally ''<domain>.<verb>''.';
comment on column public.audit_events.target_resource is
  'Stable "<type>/<id>" reference to the affected object. Used to deep-link the audit row to the resource view when the row is expanded.';
comment on column public.audit_events.details is
  'JSONB payload; shape per action key. Old/new diffs for mutations + assignments live here under ''before'' and ''after''.';

-- ====================================================================
-- RLS
-- ====================================================================

alter table public.audit_events enable row level security;

-- Master + owner can SELECT all rows. No INSERT/UPDATE/DELETE policy
-- → only the service role can write, which is what logAuditEvent uses.
-- Append-only by absence-of-policy.
create policy audit_events_select_master_owner on public.audit_events
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('master', 'owner')
    )
  );

-- ====================================================================
-- Backfill from assignment_change_log
--
-- Existing assignment-change rows show up in the unified view as
-- category='assignment'. action gets the 'assignment.' prefix so the
-- new namespacing is consistent. Both tables stay populated for one
-- release cycle so a rollback doesn't lose data.
-- ====================================================================

insert into public.audit_events (
  id, occurred_at, category, action,
  actor_id, target_profile_id, location_id,
  details
)
select
  acl.id,                                -- preserve original ids for traceability
  acl.created_at,
  'assignment',
  'assignment.' || acl.action,
  acl.actor_id,
  acl.target_profile_id,
  acl.location_id,
  jsonb_build_object('before', acl.before, 'after', acl.after)
from public.assignment_change_log acl
on conflict (id) do nothing;
