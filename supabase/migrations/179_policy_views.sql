-- POLICIES-VIEWS.1 — replace explicit acknowledgement with passive
-- view tracking. The previous model (mig 178) required staff to
-- click "I have read and understood"; the operator preference is now
-- to remove that affordance and instead track:
--   - whether a user has opened the current version
--   - how long they spent reading it
--   - which sections they dwelt on longest
--
-- Schema changes:
--   1. Drop policy_acknowledgements (no rows exist in production —
--      the policies were seeded today; nothing's been acked).
--      Trade-off: if we want explicit acks back later we'll add a
--      new mig. Cleaner than leaving a dead table around.
--   2. Add policy_views (id, policy_version_id, profile_id,
--      started_at, ended_at, total_duration_seconds, section_dwell
--      jsonb, viewed_via, ip_address, user_agent).
--
-- section_dwell shape: `{ "<section heading>": <seconds>, ... }`
-- Clients (web + mobile) detect section headings from the body
-- markdown (ALL-CAPS lines or numbered "1. HEADING" lines) and
-- report a per-section dwell count back at view-end. The admin
-- aggregate report sums these across all viewers to surface "hot"
-- sections.
--
-- RLS:
--   policy_views — SELECT for own rows OR master/owner; INSERT for
--                  own rows only; UPDATE for own rows only (to
--                  finalise the view at end-of-view). No DELETE.

set check_function_bodies = off;

-- ====================================================================
-- 1. Drop the acknowledgement table
-- ====================================================================

drop policy if exists policy_ack_select_own_or_admin on public.policy_acknowledgements;
drop policy if exists policy_ack_insert_own          on public.policy_acknowledgements;
drop table if exists public.policy_acknowledgements;

-- ====================================================================
-- 2. policy_views — view sessions, per user, per version
-- ====================================================================

create table public.policy_views (
  id                       uuid primary key default gen_random_uuid(),
  policy_version_id        uuid not null references public.policy_versions (id) on delete cascade,
  profile_id               uuid not null references public.profiles (id) on delete cascade,
  started_at               timestamptz not null default now(),
  ended_at                 timestamptz,
  total_duration_seconds   integer
                           check (total_duration_seconds is null or total_duration_seconds >= 0),
  section_dwell            jsonb,
  viewed_via               text not null default 'web'
                           check (viewed_via in ('web', 'mobile')),
  ip_address               inet,
  user_agent               text check (user_agent is null or length(user_agent) <= 500)
);

-- Look-up patterns we expect:
--   - "has this user viewed the current version?"
--      → covered by (policy_version_id, profile_id) — partial index
--        on ended_at IS NOT NULL keeps the "completed views" search
--        cheap.
--   - "all views of a given version (admin report)"
--      → policy_version_id leading covers this.
--   - "this user's recent views" → profile_id, started_at desc.
create index policy_views_version_profile_idx
  on public.policy_views (policy_version_id, profile_id);
create index policy_views_version_completed_idx
  on public.policy_views (policy_version_id)
  where ended_at is not null;
create index policy_views_profile_recent_idx
  on public.policy_views (profile_id, started_at desc);

comment on table public.policy_views is
  'POLICIES-VIEWS.1 — passive view-tracking sessions. One row per view session per user per policy_version. section_dwell is a {section_heading: seconds} JSONB map populated at view-end.';

comment on column public.policy_views.ended_at is
  'NULL while the session is still open (the start-view route inserts the row, end-view sets this). Stale-open rows can be cleaned up by a cron if needed; for now they just sit there.';

comment on column public.policy_views.section_dwell is
  'JSONB {section_heading: seconds_dwelt}. Clients (web + mobile) detect section boundaries from the body markdown and report per-section dwell back at end-view. Used for the admin "hot sections" aggregate.';


-- ====================================================================
-- 3. RLS
-- ====================================================================

alter table public.policy_views enable row level security;

-- Users see their own view rows; master/owner see all (admin report).
create policy policy_views_select_own_or_admin on public.policy_views
  for select to authenticated
  using (
    profile_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (p.role = 'master' or p.role = 'owner')
    )
  );

-- Users insert their own rows (start-view route).
create policy policy_views_insert_own on public.policy_views
  for insert to authenticated
  with check (profile_id = auth.uid());

-- Users update their own rows (end-view route — sets ended_at +
-- duration + section_dwell). Restricted further at the API layer
-- (cannot mutate started_at or profile_id) but the row owner is the
-- only one who can write to their own session.
create policy policy_views_update_own on public.policy_views
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- No DELETE policy — view records are append-only from the
-- application's perspective.
