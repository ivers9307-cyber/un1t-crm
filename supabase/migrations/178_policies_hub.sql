-- POLICIES.1 — versioned HR policies hosted inside the CRM.
--
-- Replaces the previous pattern of "policy document lives on a Google
-- Drive somewhere, referenced from the contract". Now staff read the
-- Employee Handbook, Acceptable Use Policy, and Staff Privacy Notice
-- inside the CRM, and we track exactly who's acknowledged which
-- version when. Required for GDPR transparency + WRC-defence: if a
-- policy is ever cited in a dismissal or grievance, we want a
-- timestamped record of acknowledgement.
--
-- Data model:
--   policies                  one row per logical policy (Handbook,
--                             AUP, Privacy Notice, future additions).
--                             Stable identity; the body lives in
--                             policy_versions so we can republish
--                             without losing history.
--   policy_versions           append-only log of versions for each
--                             policy. Exactly one is_current per
--                             active policy at any time (enforced by
--                             a partial unique index). Includes a
--                             change_summary so staff see WHAT
--                             changed when they get re-asked to
--                             acknowledge.
--   policy_acknowledgements   per-user, per-version. UNIQUE on
--                             (policy_version_id, profile_id) so a
--                             user can't ack the same version twice.
--
-- Lifecycle:
--   1. Admin creates a policy in /admin/policies (master/owner only).
--   2. Admin writes the first policy_versions row → it becomes
--      is_current automatically.
--   3. Staff visit /policies and ack the current version.
--   4. Admin publishes a new policy_versions row → the previous
--      row is flipped to is_current = false. Staff who'd acked the
--      previous version now show as unacknowledged in the report,
--      and see the unread-policies banner on next login.
--
-- RLS:
--   policies                  SELECT for any authenticated user.
--                             INSERT/UPDATE/DELETE for master/owner
--                             (enforced both by RLS and at the API
--                             layer; defence in depth).
--   policy_versions           SELECT for any authenticated user
--                             (everyone needs to read the current
--                             version + see history if they look
--                             back). INSERT/UPDATE for master/owner.
--   policy_acknowledgements   SELECT/INSERT for the row's owner
--                             (profile_id = auth.uid()'s profile);
--                             SELECT for master/owner across all
--                             (for the admin "who's acked what"
--                             report). No UPDATE or DELETE — acks
--                             are an append-only audit record.

set check_function_bodies = off;


-- =====================================================================
-- policies — one row per logical policy
-- =====================================================================

create table public.policies (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique
                check (slug ~ '^[a-z0-9-]+$' and length(slug) between 2 and 64),
  title         text not null check (length(title) between 1 and 200),
  description   text check (description is null or length(description) <= 1000),
  display_order smallint not null default 100,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index policies_active_order_idx on public.policies (active, display_order, title)
  where active = true;

comment on table  public.policies is 'POLICIES.1 — logical HR policies (Handbook, AUP, Privacy Notice, etc.). Body lives in policy_versions.';
comment on column public.policies.slug is 'Stable URL-safe identifier — /policies/<slug>.';
comment on column public.policies.display_order is 'Lower numbers sort first on /policies. Default 100 so new entries land below explicitly-ordered ones.';


-- =====================================================================
-- policy_versions — append-only version history
-- =====================================================================

create table public.policy_versions (
  id              uuid primary key default gen_random_uuid(),
  policy_id       uuid not null references public.policies (id) on delete cascade,
  version_number  integer not null check (version_number >= 1),
  body_markdown   text not null check (length(body_markdown) between 1 and 200000),
  change_summary  text check (change_summary is null or length(change_summary) <= 2000),
  effective_date  date not null,
  published_at    timestamptz not null default now(),
  published_by    uuid references public.profiles (id) on delete set null,
  is_current      boolean not null default true,

  -- Version numbers are monotonic per policy.
  constraint policy_versions_policy_version_unique
    unique (policy_id, version_number)
);

-- Only one is_current per policy. Partial unique index — admin route
-- flips the previous row to false before inserting the new one (done
-- in a single transaction in the publish-version handler).
create unique index policy_versions_one_current_per_policy_idx
  on public.policy_versions (policy_id)
  where is_current = true;

create index policy_versions_policy_idx on public.policy_versions (policy_id, version_number desc);

comment on table  public.policy_versions is 'POLICIES.1 — append-only version history per policy. Exactly one is_current per policy at any time.';
comment on column public.policy_versions.change_summary is 'Operator-supplied 1-2 sentence description of what changed in this version. Shown to staff when re-acknowledgement is requested.';
comment on column public.policy_versions.effective_date is 'Date this version becomes effective. Often = published_at::date but can be set in the future for legally-effective dates.';


-- =====================================================================
-- policy_acknowledgements — per-user, per-version, append-only
-- =====================================================================

create table public.policy_acknowledgements (
  id                 uuid primary key default gen_random_uuid(),
  policy_version_id  uuid not null references public.policy_versions (id) on delete cascade,
  profile_id         uuid not null references public.profiles (id) on delete cascade,
  acknowledged_at    timestamptz not null default now(),
  acknowledged_via   text not null default 'web'
                     check (acknowledged_via in ('web', 'mobile')),
  ip_address         inet,
  user_agent         text check (user_agent is null or length(user_agent) <= 500),

  -- A user can only ack a given version once. Subsequent POSTs to
  -- /acknowledge are idempotent no-ops.
  constraint policy_ack_unique_per_user_version
    unique (policy_version_id, profile_id)
);

create index policy_acknowledgements_profile_idx
  on public.policy_acknowledgements (profile_id, acknowledged_at desc);

comment on table public.policy_acknowledgements is 'POLICIES.1 — append-only record of which user acknowledged which policy version. Used for the staff "outstanding policies" prompt and the admin "who has acked what" report.';


-- =====================================================================
-- updated_at trigger for policies (versions and acks are append-only)
-- =====================================================================

create or replace function public.policies_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger policies_set_updated_at_trg
  before update on public.policies
  for each row execute function public.policies_set_updated_at();


-- =====================================================================
-- RLS
-- =====================================================================

alter table public.policies                 enable row level security;
alter table public.policy_versions          enable row level security;
alter table public.policy_acknowledgements  enable row level security;

-- policies — read for all authenticated, write for master/owner.
create policy policies_read_all on public.policies
  for select to authenticated using (true);

create policy policies_admin_write on public.policies
  for all to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (p.role = 'master' or p.role = 'owner')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (p.role = 'master' or p.role = 'owner')
    )
  );

-- policy_versions — read for all, write for master/owner.
create policy policy_versions_read_all on public.policy_versions
  for select to authenticated using (true);

create policy policy_versions_admin_write on public.policy_versions
  for all to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (p.role = 'master' or p.role = 'owner')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (p.role = 'master' or p.role = 'owner')
    )
  );

-- policy_acknowledgements — owner can read + insert their own row.
-- Master/owner can read all rows for the admin report.
create policy policy_ack_select_own_or_admin on public.policy_acknowledgements
  for select to authenticated
  using (
    profile_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (p.role = 'master' or p.role = 'owner')
    )
  );

create policy policy_ack_insert_own on public.policy_acknowledgements
  for insert to authenticated
  with check (profile_id = auth.uid());

-- No update / delete policy → acks are immutable from the application.
-- (Direct service-role inserts still work for migrations / seeding.)


-- =====================================================================
-- Seed: Employee Handbook, Acceptable Use Policy, Staff Privacy Notice
-- as v1 placeholders. Full content is loaded by the application
-- bootstrap from the three .md files in the repo; this migration just
-- provides the policy rows + version stubs so the UI has something
-- to render on first deploy. An admin will replace the body via the
-- /admin/policies/[slug]/versions/new flow before staff are notified.
-- =====================================================================

insert into public.policies (slug, title, description, display_order, active)
values
  ('employee-handbook', 'Employee Handbook',
   'Code of conduct, working time, leave entitlements, disciplinary and grievance procedures, dignity at work, and related HR policies.',
   10, true),
  ('acceptable-use-policy', 'Acceptable Use Policy',
   'How you may use the Company''s IT and communications resources — accounts, email, social media, AI tools, BYOD, monitoring.',
   20, true),
  ('staff-privacy-notice', 'Staff Privacy Notice',
   'What personal data we process about you, why, who we share it with, how long we keep it, and your rights under the GDPR.',
   30, true);

insert into public.policy_versions (policy_id, version_number, body_markdown, change_summary, effective_date)
select
  p.id,
  1,
  '[Placeholder — paste the contents of ' || p.slug || '.md into this version before notifying staff. An admin can do this from /admin/policies/' || p.slug || '/versions/new.]',
  'Initial version.',
  current_date
from public.policies p;
