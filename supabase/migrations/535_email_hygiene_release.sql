-- 535 — HYGREL.1: reverse the 12 Aug engagement suppression for current
-- members, and give that reversal something that makes it stick.
--
-- WHAT HAPPENED
-- ─────────────
-- email-engagement-sweep (mig 395, cron 05:15 UTC) suppresses a contact when
-- ALL of: still consented, >=3 marketing sends in 90 days, zero opens AND zero
-- clicks in 90 days, and FIRST marketing send >90 days ago. That last clause is
-- meant as "never punish new contacts".
--
-- The CRM's first email ever was 2026-05-13. 13 May + 90 days = 11 Aug, so the
-- entire founding cohort crossed that guard on the same night: the 12 Aug
-- 05:15 run stamped 1,107 contacts in ONE pass — roughly a third of everyone
-- ever emailed. On a list people join continuously the clause yields a
-- trickle; on a list that started sending on a single day it yields a cliff.
-- The sweep is not defective. Its rule simply has no notion of a cohort.
--
-- Of the 1,107: 913 dormant, 146 member, 44 pack_member, 3 cold_lead, 1
-- gympass. Richard's call (2026-08-12): release the 190 CURRENT MEMBERS, keep
-- the 913 dormant suppressed. Dormant non-openers are exactly what list
-- hygiene is for; paying members quietly losing marketing reach are not —
-- especially on evidence a pixel-blocking mail client reproduces exactly.
--
-- Only marketing was ever affected: email_suppressed_at does not gate
-- administrative or transactional mail, so nobody stopped receiving booking
-- confirmations or reminders.
--
-- WHY A BARE CLEAR WOULD NOT HAVE WORKED
-- ──────────────────────────────────────
-- Those 190 still satisfy every sweep criterion. Clearing email_suppressed_at
-- on its own puts them straight back into the candidate population and the
-- next 05:15 run re-stamps them the same night. The release therefore needs a
-- marker the sweep honours, which is what the column and table below are for.
--
-- Permanence follows the precedent already set for the bounce path in
-- /api/communications/list-health/[id]/release: "An operator release is
-- PERMANENT as far as the sweep is concerned — it never re-suppresses that
-- contact. A rule that overrules a human every night is not a rule, it is a
-- nag." Same reasoning, same behaviour, so the two release paths cannot drift
-- into meaning different things.
--
-- ORDERING — READ BEFORE APPLYING
-- ───────────────────────────────
-- This migration is HALF the fix. The sweep does not yet read the marker; that
-- is a one-line code change shipping alongside. Apply this and the release is
-- real immediately, but it survives only until 05:15 UTC unless the sweep
-- change is deployed first. Land them together.
--
-- Forward-only. Idempotent: the column/table guards are IF NOT EXISTS and the
-- release predicate cannot match an already-released contact.

-- ── 1. the audit row the engagement path has never had ───────────────────
-- The repeat-bounce sweep writes email_bounce_escalations (mig 515); the
-- ENGAGEMENT sweep writes nothing at all, which is why releasing one of its
-- suppressions previously meant hand-written SQL leaving no trace of who did
-- it or why. This is that trace.
create table if not exists email_hygiene_releases (
  id           uuid        primary key default gen_random_uuid(),
  contact_id   uuid        not null references contacts(id) on delete cascade,
  -- REQUIRED, same reasoning as mig 515: service-role routes bypass RLS, so
  -- this column is the only tenant boundary the list-health surface has, and
  -- check:location-scoping derives the tenant-table set from it.
  location_id  uuid        not null references locations(id),
  released_at  timestamptz not null default now(),
  -- NULL = released by a migration or another system path rather than a
  -- person. The bulk release below is the first such row.
  released_by  uuid        references profiles(id),
  note         text        not null,
  created_at   timestamptz not null default now()
);

create index if not exists email_hygiene_releases_contact
  on email_hygiene_releases (contact_id);
create index if not exists email_hygiene_releases_location
  on email_hygiene_releases (location_id, released_at desc);

alter table email_hygiene_releases enable row level security;

-- ONE permissive SELECT policy scoped by location (the mig 515 / 510 / 487
-- shape). Deliberately NOT a restrictive FOR ALL USING (false) to "deny
-- writes": that denies SELECT too and fails silently (migs 483/485, gated by
-- check:rls-restrictive). No write policies — RLS is default-deny and the only
-- writer is the release route on the service-role client. A staff-writable
-- audit table would let anyone with a session rewrite why a contact was
-- released, which defeats the point of recording it.
drop policy if exists email_hygiene_releases_select on email_hygiene_releases;
create policy email_hygiene_releases_select
  on email_hygiene_releases
  as permissive for select to authenticated
  using (private.auth_is_in_location(location_id));

comment on table email_hygiene_releases is
  'HYGREL.1 (mig 535) — audit trail for releases of the ENGAGEMENT hygiene suppression (contacts.email_suppressed_at, mig 395), which the sweep itself writes with no audit row. The bounce path has its own table (email_bounce_escalations, mig 515). A release is permanent: contacts.email_hygiene_released_at is set at the same time and the engagement sweep skips any contact carrying it.';

-- ── 2. the marker the sweep honours ──────────────────────────────────────
-- Denormalised onto contacts on purpose so the sweep's candidate query stays a
-- plain .is('email_hygiene_released_at', null) — the same denormalise-to-filter
-- pattern the repo already uses for contacts.email_marketing and
-- pipeline_stage_slug. It is written in lockstep with an email_hygiene_releases
-- row; the table is the history, this column is the gate.
alter table contacts
  add column if not exists email_hygiene_released_at timestamptz;

comment on column contacts.email_hygiene_released_at is
  'HYGREL.1 (mig 535) — set when an operator releases an ENGAGEMENT hygiene suppression. The email-engagement-sweep cron skips any contact carrying it, permanently, matching the bounce-release precedent. NULL means never released. Does not affect reputation (email_status) or consent (contact_location_preferences); it only stops the 90-day non-opener sweep re-stamping email_suppressed_at.';

-- ── 3. the release itself ────────────────────────────────────────────────
-- Derived from predicates, never a hard-coded id list, so what executed is
-- legible and re-derivable:
--   • currently carrying the engagement stamp,
--   • NOT a repeat-bounce suppression (those keep their own audit row and
--     their own release path — releasing one here would bypass mig 515's
--     trail and silently un-suppress a genuinely bouncing address),
--   • a current member: pipeline_stage_slug in ('member','pack_member').
with released as (
  update contacts c
     set email_suppressed_at        = null,
         email_hygiene_released_at  = now()
   where c.email_suppressed_at is not null
     and c.email_hygiene_released_at is null
     and c.pipeline_stage_slug in ('member', 'pack_member')
     and not exists (
       select 1 from email_bounce_escalations e
        where e.contact_id = c.id
          and e.decision = 'suppress'
     )
  returning c.id, c.location_id
)
insert into email_hygiene_releases (contact_id, location_id, released_by, note)
select r.id, r.location_id, null,
       'Bulk release 2026-08-12 (HYGREL.1, mig 535): current member caught by the '
       || 'one-off engagement-sweep cliff of 12 Aug, when the whole founding cohort '
       || 'crossed the 90-day first-send guard together. Operator decision: dormant '
       || 'non-openers stay suppressed, paying members do not.'
  from released r;

-- ── post-flight ──────────────────────────────────────────────────────────
do $$
declare
  released_count int;
  still_stuck    int;
  dormant_left   int;
begin
  select count(*) into released_count
    from email_hygiene_releases
   where note like 'Bulk release 2026-08-12%';

  -- Nobody matching the release predicate may still be suppressed.
  select count(*) into still_stuck
    from contacts c
   where c.email_suppressed_at is not null
     and c.pipeline_stage_slug in ('member', 'pack_member')
     and not exists (
       select 1 from email_bounce_escalations e
        where e.contact_id = c.id and e.decision = 'suppress'
     );
  if still_stuck > 0 then
    raise exception 'mig 535 FAILED: % current members are still engagement-suppressed', still_stuck;
  end if;

  -- The dormant population must be UNTOUCHED. This migration narrows an
  -- audience deliberately chosen to stay narrowed; silently widening it back
  -- would be the opposite of the decision taken.
  select count(*) into dormant_left
    from contacts
   where email_suppressed_at is not null;

  raise notice 'mig 535 — released % current members; % contacts remain suppressed (dormant + bounce escalations, deliberately).',
    released_count, dormant_left;
end $$;
